import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const APPROVALS_PATH = path.join(ROOT, "config", "catalog-moderation-approvals.json");
const PHOTOS_ROOT = path.join(ROOT, "public", "miniapp", "photos");
const REPORT_PATH = path.join(ROOT, "data", "catalog-moderation", "applied-report.json");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const options = parseOptions(process.argv.slice(2));

await main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

async function main() {
  const approvals = await readApprovals();
  const results = [];

  for (const item of approvals.items || []) {
    results.push(await applyItem(item, options));
  }

  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify({
    appliedAt: new Date().toISOString(),
    approvalsPath: relative(APPROVALS_PATH),
    dryRun: options.dryRun,
    totals: {
      items: results.length,
      applied: results.filter((result) => result.status === "applied").length,
      ready: results.filter((result) => result.status === "ready").length,
      skipped: results.filter((result) => result.status === "skipped").length,
      errors: results.filter((result) => result.status === "error").length
    },
    results
  }, null, 2)}\n`, "utf8");

  if (!options.dryRun) {
    runProjectScript("photos:manifest");
    runProjectScript("photos:audit");
  }

  console.log(options.dryRun
    ? `Ready catalog approvals: ${results.filter((result) => result.status === "ready").length}`
    : `Applied catalog approvals: ${results.filter((result) => result.status === "applied").length}`);
  console.log(`Report: ${relative(REPORT_PATH)}`);
}

async function readApprovals() {
  try {
    return JSON.parse(await fs.readFile(APPROVALS_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error([
        "Approval file was not found.",
        "1. Run: npm run catalog:moderation:candidates",
        "2. Run: npm run catalog:moderation:open",
        "3. Tick approved photos and press Export approvals JSON",
        "4. Save it as config/catalog-moderation-approvals.json",
        "5. Run this command again"
      ].join("\n"));
    }

    throw error;
  }
}

async function applyItem(item, options) {
  if (!item?.approved) {
    return baseResult(item, "skipped", "not approved");
  }

  const section = safeSegment(item.section);
  const id = safeSegment(item.id);
  const candidateFile = String(item.photoCandidateFile || "").trim();

  if (!section || !id || !candidateFile) {
    return baseResult(item, "error", "missing section, id or photoCandidateFile");
  }

  const sourcePath = path.resolve(ROOT, candidateFile);
  if (!isInside(ROOT, sourcePath)) {
    return baseResult(item, "error", "photoCandidateFile points outside project");
  }

  const extension = path.extname(sourcePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) {
    return baseResult(item, "error", "unsupported image extension");
  }

  try {
    await fs.access(sourcePath);
  } catch {
    return baseResult(item, "error", "candidate file does not exist");
  }

  const targetBaseName = safeFileBase(item.targetFileName) || "1";
  const targetFolder = path.join(PHOTOS_ROOT, section, id);
  const targetPath = path.join(targetFolder, `${targetBaseName}${extension}`);

  if (!isInside(PHOTOS_ROOT, targetPath)) {
    return baseResult(item, "error", "target path points outside photos folder");
  }

  if (options.dryRun) {
    return {
      ...baseResult(item, "ready", "photo can be copied"),
      sourceFile: relative(sourcePath),
      targetFile: relative(targetPath)
    };
  }

  await fs.mkdir(targetFolder, { recursive: true });
  await fs.copyFile(sourcePath, targetPath);

  const metadata = {
    appliedAt: new Date().toISOString(),
    sourceCandidateFile: relative(sourcePath),
    moderationNote: item.note || ""
  };
  await fs.writeFile(`${targetPath}.moderation.json`, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  return {
    ...baseResult(item, "applied", "photo copied"),
    sourceFile: relative(sourcePath),
    targetFile: relative(targetPath)
  };
}

function baseResult(item, status, message) {
  return {
    section: item?.section || "",
    id: item?.id || "",
    title: item?.title || "",
    status,
    message
  };
}

function runProjectScript(scriptName) {
  const result = spawnSync("npm", ["run", scriptName], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32"
  });

  if (result.status !== 0) {
    throw new Error(`npm run ${scriptName} failed`);
  }
}

function isInside(parentPath, childPath) {
  const relativePath = path.relative(parentPath, childPath);
  return Boolean(relativePath) && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function safeSegment(value) {
  const normalized = String(value || "").trim();
  return /^[a-z0-9_-]+$/i.test(normalized) ? normalized : "";
}

function safeFileBase(value) {
  const normalized = String(value || "").trim();
  return /^[a-z0-9_-]+$/i.test(normalized) ? normalized : "";
}

function relative(targetPath) {
  return path.relative(ROOT, targetPath).replaceAll("\\", "/");
}

function parseOptions(args) {
  return {
    dryRun: args.includes("--dry-run")
  };
}
