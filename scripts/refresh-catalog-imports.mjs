import { spawnSync } from "node:child_process";

const scripts = [
  "catalog:sights",
  "catalog:parks",
  "catalog:food",
  "catalog:hotels",
  "catalog:excursions",
  "catalog:routes",
  "catalog:active",
  "catalog:roadtrip",
  "catalog:sources"
];

for (const script of scripts) {
  console.log(`\n=== Running ${script} ===`);

  const command = process.platform === "win32"
    ? { bin: "cmd.exe", args: ["/d", "/s", "/c", `npm run ${script}`] }
    : { bin: "npm", args: ["run", script] };

  const result = spawnSync(command.bin, command.args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

console.log("\nCatalog refresh completed.");
