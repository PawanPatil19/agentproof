import { readFile } from "node:fs/promises";
import { commitmentKeyBytes } from "@agentproof/core";
import { CliError } from "../io.ts";

/** Read a commitment key file (hex or base64 text, at least 16 bytes). */
export async function commitmentKeyFromFile(path: string): Promise<Buffer> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new CliError(`cannot read commitment key ${path}`);
  }
  try {
    return commitmentKeyBytes(text);
  } catch (error) {
    throw new CliError(`${path}: ${(error as Error).message}`);
  }
}
