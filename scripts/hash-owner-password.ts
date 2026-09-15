import { stdin, stdout } from "node:process";
import { hashOwnerPassword } from "../server/auth";

if (!stdin.isTTY) {
  throw new Error("Run this command in an interactive terminal so the password is not exposed in shell history.");
}

async function readHidden(prompt: string) {
  stdout.write(prompt);
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  let value = "";
  try {
    return await new Promise<string>((resolve, reject) => {
      const onData = (chunk: string) => {
        for (const character of chunk) {
          if (character === "\u0003") {
            stdin.off("data", onData);
            reject(new Error("Cancelled."));
            return;
          }
          if (character === "\r" || character === "\n") {
            stdin.off("data", onData);
            stdout.write("\n");
            resolve(value);
            return;
          }
          if (character === "\u007f") {
            value = value.slice(0, -1);
            continue;
          }
          if (character >= " ") value += character;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode?.(false);
    stdin.pause();
  }
}

try {
  const password = await readHidden("New PitchRadar owner password: ");
  const confirmation = await readHidden("Repeat password: ");
  if (password !== confirmation) throw new Error("Passwords do not match.");
  console.log(await hashOwnerPassword(password));
  console.log("Store this hash as PITCHRADAR_OWNER_PASSWORD_HASH. Do not store the password.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
