//! Lets extensions take part in the file operations the user makes: before
//! (they may add edits, e.g. update imports when a file moves) and after. The
//! extension host sets the participant; without one, operations just run.

export type FileOperation =
  | { kind: "create" | "delete"; paths: string[] }
  | { kind: "rename"; pairs: { from: string; to: string }[] };

interface Participant {
  will(operation: FileOperation): Promise<void>;
  did(operation: FileOperation): void;
}

let participant: Participant | null = null;

export function setFileOperationParticipant(value: Participant | null) {
  participant = value;
}

/** Runs `operation` between the participant's `will` and `did`; a failing participant never stops it. */
export async function runFileOperation<T>(operation: FileOperation, run: () => Promise<T>): Promise<T> {
  try {
    await participant?.will(operation);
  } catch {
    // Logged by the participant.
  }
  const result = await run();
  participant?.did(operation);
  return result;
}
