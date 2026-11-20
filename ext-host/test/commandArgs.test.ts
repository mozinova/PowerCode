// Command arguments JSON cannot carry stay in the host (dto.command): the TypeScript
// extension's completion items carry themselves as their command's argument, and
// sending that cycle to the UI made every TypeScript completion request fail.
// Run with `bun test`.

import { describe, expect, test } from "bun:test";
import { command, commandArgs } from "../src/dto";
import { Range, Uri } from "../src/types";

describe("command arguments", () => {
  test("plain JSON arguments travel as they are", () => {
    const dto = command({ title: "Run", command: "x.run", arguments: ["a", 1, { deep: [true, null] }] });
    expect(dto?.arguments).toEqual(["a", 1, { deep: [true, null] }]);
    expect(commandArgs(dto?.arguments)).toBeNull();
  });

  test("a cycle stays here and comes back as the same object", () => {
    const item: any = { label: "getState" };
    item.command = { title: "", command: "_typescript.onCompletionAccepted", arguments: [item] };
    const dto = command(item.command);
    expect(() => JSON.stringify(dto)).not.toThrow();
    const back = commandArgs(JSON.parse(JSON.stringify(dto!.arguments)));
    expect(back?.[0]).toBe(item);
  });

  test("class instances (Uri, Range) keep their type", () => {
    const uri = Uri.file("C:/a.ts");
    const range = new Range(1, 2, 3, 4);
    const back = commandArgs(JSON.parse(JSON.stringify(command({ title: "", command: "x", arguments: [uri, range] })!.arguments)));
    expect(back?.[0]).toBe(uri);
    expect(back?.[1]).toBe(range);
  });
});
