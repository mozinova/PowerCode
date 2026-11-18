//! Find in Files: searches file contents under the project root, honouring
//! `.gitignore`, and streams matches per file as they are found.

use ignore::overrides::OverrideBuilder;
use ignore::{WalkBuilder, WalkState};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

use crate::error::{err, CmdResult};
use crate::remote::{self, Remotes};

/// Files larger than this are skipped (minified bundles, data dumps, ...).
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Stop after this many matching lines in total.
const MAX_MATCHES: usize = 10_000;
/// Longest line preview sent to the UI, in bytes.
const PREVIEW_BYTES: usize = 300;
/// Context kept before the first match when a long line is cut.
const PREVIEW_LEAD_BYTES: usize = 60;

const SKIPPED_DIRS: &[&str] = &[".git"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
    /// Comma-separated globs; when present, only matching files are searched.
    include: String,
    /// Comma-separated globs of files to skip.
    exclude: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    /// 1-based line number.
    line: u32,
    /// 1-based UTF-16 columns of the first match in the full line (Monaco's units).
    column: u32,
    end_column: u32,
    preview: String,
    /// UTF-16 `[start, end)` offsets of every match within `preview`.
    ranges: Vec<(u32, u32)>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    path: String,
    relative: String,
    matches: Vec<LineMatch>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchSummary {
    files: usize,
    matches: usize,
    truncated: bool,
}

#[derive(Serialize, Clone)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum SearchEvent {
    File(FileMatches),
    Done(SearchSummary),
}

/// Each new search bumps the generation; older searches see it and stop.
#[derive(Default)]
pub struct Searches {
    generation: Arc<AtomicU64>,
}

fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

fn floor_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn build_regex(options: &SearchOptions) -> CmdResult<Regex> {
    let mut pattern = if options.regex {
        options.query.clone()
    } else {
        regex::escape(&options.query)
    };
    if options.whole_word {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    RegexBuilder::new(&pattern)
        .case_insensitive(!options.case_sensitive)
        .build()
        .map_err(|e| format!("Invalid regular expression: {e}"))
}

fn globs(list: &str) -> impl Iterator<Item = String> + '_ {
    list.split(',').map(str::trim).filter(|g| !g.is_empty()).map(|g| {
        // `src/` means everything inside src, as in VS Code.
        if g.ends_with('/') {
            format!("{g}**")
        } else {
            g.to_string()
        }
    })
}

/// Matches of `re` in one line, or None if it has none.
fn match_line(re: &Regex, line: &str, number: usize) -> Option<LineMatch> {
    let found: Vec<_> = re.find_iter(line).filter(|m| !m.is_empty()).collect();
    let first = found.first()?;

    // Cut long lines around the first match.
    let start = if line.len() > PREVIEW_BYTES {
        floor_boundary(line, first.start().saturating_sub(PREVIEW_LEAD_BYTES))
    } else {
        0
    };
    let end = floor_boundary(line, (start + PREVIEW_BYTES).min(line.len()));
    let window = &line[start..end];
    let trimmed = window.trim_start();
    let offset = start + (window.len() - trimmed.len());
    let preview = trimmed.trim_end();

    let ranges = found
        .iter()
        .filter(|m| m.start() >= offset && m.start() < offset + preview.len())
        .map(|m| {
            let s = utf16_len(&line[offset..m.start()]);
            let e = utf16_len(&line[offset..m.end().min(offset + preview.len())]);
            (s, e)
        })
        .collect();

    Some(LineMatch {
        line: number as u32 + 1,
        column: utf16_len(&line[..first.start()]) + 1,
        end_column: utf16_len(&line[..first.end()]) + 1,
        preview: preview.to_string(),
        ranges,
    })
}

/// Searches an SSH workspace: `grep` on the host finds candidate lines, and
/// they are matched again here so highlights follow the same rules as local
/// searches. Regex searches use grep's extended syntax to find candidates.
async fn search_remote(
    remotes: &Remotes,
    host: &str,
    dir: &str,
    options: &SearchOptions,
    re: &Regex,
) -> CmdResult<Vec<FileMatches>> {
    let mut script = format!(
        "cd -- {} && grep -rnIH --exclude-dir=.git --exclude-dir=node_modules",
        remote::quote(dir)
    );
    if !options.case_sensitive {
        script.push_str(" -i");
    }
    if options.whole_word {
        script.push_str(" -w");
    }
    script.push_str(if options.regex { " -E" } else { " -F" });
    for glob in globs(&options.include) {
        script.push_str(&format!(" --include={}", remote::quote(&glob)));
    }
    for glob in globs(&options.exclude) {
        script.push_str(&format!(" --exclude={}", remote::quote(&glob)));
    }
    // `head` ends the pipeline, so "no matches" (grep's status 1) is not an error.
    script.push_str(&format!(" -e {} . | head -n {MAX_MATCHES}", remote::quote(&options.query)));

    let output = Remotes::exec(remotes, host, script).await?;
    let output = String::from_utf8_lossy(&output);
    let mut files: Vec<FileMatches> = Vec::new();
    for line in output.lines() {
        // `./relative/path:line:text`
        let Some((path, rest)) = line.strip_prefix("./").unwrap_or(line).split_once(':') else { continue };
        let Some((number, text)) = rest.split_once(':') else { continue };
        let Ok(number) = number.parse::<usize>() else { continue };
        let Some(found) = match_line(re, text, number.saturating_sub(1)) else { continue };
        match files.last_mut() {
            Some(file) if file.relative == path => file.matches.push(found),
            _ => files.push(FileMatches {
                path: remote::join(host, &format!("{}/{path}", dir.trim_end_matches('/'))),
                relative: path.to_string(),
                matches: vec![found],
            }),
        }
    }
    Ok(files)
}

#[tauri::command]
pub async fn search_in_files(
    state: State<'_, Searches>,
    remotes: State<'_, Remotes>,
    root: String,
    options: SearchOptions,
    on_event: Channel<SearchEvent>,
) -> CmdResult<()> {
    let generation = state.generation.clone();
    let this_search = generation.fetch_add(1, Ordering::SeqCst) + 1;

    if options.query.is_empty() {
        let _ = on_event.send(SearchEvent::Done(SearchSummary {
            files: 0,
            matches: 0,
            truncated: false,
        }));
        return Ok(());
    }

    let re = build_regex(&options)?;
    if let Some((host, dir)) = remote::parse(&root) {
        let found = search_remote(&remotes, host, &dir, &options, &re).await?;
        // A newer search started while this one ran on the host.
        if generation.load(Ordering::SeqCst) != this_search {
            return Ok(());
        }
        let matches: usize = found.iter().map(|f| f.matches.len()).sum();
        let files = found.len();
        for file in found {
            let _ = on_event.send(SearchEvent::File(file));
        }
        let _ = on_event.send(SearchEvent::Done(SearchSummary {
            files,
            matches,
            truncated: matches >= MAX_MATCHES,
        }));
        return Ok(());
    }
    let mut overrides = OverrideBuilder::new(&root);
    for glob in globs(&options.include) {
        overrides.add(&glob).map_err(err)?;
    }
    for glob in globs(&options.exclude) {
        overrides.add(&format!("!{glob}")).map_err(err)?;
    }
    let overrides = overrides.build().map_err(err)?;

    tauri::async_runtime::spawn_blocking(move || {
        let files = AtomicUsize::new(0);
        let matches = AtomicUsize::new(0);
        let walker = WalkBuilder::new(&root)
            .hidden(false)
            .require_git(false)
            .overrides(overrides)
            .filter_entry(|e| !SKIPPED_DIRS.contains(&e.file_name().to_string_lossy().as_ref()))
            .build_parallel();

        walker.run(|| {
            let (re, root, on_event, generation) = (&re, &root, &on_event, &generation);
            let (files, matches) = (&files, &matches);
            Box::new(move |entry| {
                if generation.load(Ordering::SeqCst) != this_search || matches.load(Ordering::Relaxed) >= MAX_MATCHES {
                    return WalkState::Quit;
                }
                let Ok(entry) = entry else { return WalkState::Continue };
                if !entry.file_type().is_some_and(|t| t.is_file())
                    || entry.metadata().map_or(true, |m| m.len() > MAX_FILE_BYTES)
                {
                    return WalkState::Continue;
                }
                let Ok(bytes) = std::fs::read(entry.path()) else { return WalkState::Continue };
                // NUL bytes near the start mean a binary file.
                if bytes[..bytes.len().min(8000)].contains(&0) {
                    return WalkState::Continue;
                }
                let Ok(text) = std::str::from_utf8(&bytes) else { return WalkState::Continue };

                let found: Vec<_> = text
                    .lines()
                    .enumerate()
                    .filter_map(|(i, line)| match_line(re, line, i))
                    .collect();
                if found.is_empty() {
                    return WalkState::Continue;
                }
                matches.fetch_add(found.len(), Ordering::Relaxed);
                files.fetch_add(1, Ordering::Relaxed);
                let path = entry.path();
                let relative = path.strip_prefix(root).unwrap_or(path);
                let _ = on_event.send(SearchEvent::File(FileMatches {
                    path: path.to_string_lossy().into_owned(),
                    relative: relative.to_string_lossy().into_owned(),
                    matches: found,
                }));
                WalkState::Continue
            })
        });

        if generation.load(Ordering::SeqCst) == this_search {
            let total = matches.load(Ordering::Relaxed);
            let _ = on_event.send(SearchEvent::Done(SearchSummary {
                files: files.load(Ordering::Relaxed),
                matches: total,
                truncated: total >= MAX_MATCHES,
            }));
        }
    })
    .await
    .map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(query: &str, whole_word: bool, regex: bool) -> SearchOptions {
        SearchOptions {
            query: query.into(),
            case_sensitive: false,
            whole_word,
            regex,
            include: String::new(),
            exclude: String::new(),
        }
    }

    #[test]
    fn highlights_every_match_in_utf16_units() {
        let re = build_regex(&options("é", false, false)).unwrap();
        let m = match_line(&re, "    café É", 4).unwrap();
        assert_eq!(m.line, 5);
        assert_eq!(m.preview, "café É");
        assert_eq!(m.ranges, vec![(3, 4), (5, 6)]);
        assert_eq!((m.column, m.end_column), (8, 9));
    }

    #[test]
    fn whole_word_and_regex() {
        let re = build_regex(&options("foo", true, false)).unwrap();
        assert!(match_line(&re, "foobar", 0).is_none());
        assert!(match_line(&re, "a foo b", 0).is_some());
        assert!(build_regex(&options("(", false, true)).is_err());
    }

    #[test]
    fn cuts_long_lines_around_the_match() {
        let line = format!("{}needle{}", "x".repeat(1000), "y".repeat(1000));
        let re = build_regex(&options("needle", false, false)).unwrap();
        let m = match_line(&re, &line, 0).unwrap();
        assert!(m.preview.len() <= PREVIEW_BYTES);
        let (s, e) = m.ranges[0];
        assert_eq!(&m.preview[s as usize..e as usize], "needle");
        assert_eq!(m.column, 1001);
    }
}
