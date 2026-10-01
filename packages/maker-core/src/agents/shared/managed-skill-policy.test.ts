import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalSkillPath } from "./skill-activation.js";
import { snapshotManagedSkillGrants } from "./managed-skill-policy.js";

describe("managed skill Bot grants", () => {
  it("grants the physical catalog source and does not follow an alias retargeted after approval", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "cindy-managed-grants-"),
    );
    try {
      const approved = path.join(root, "approved");
      const replaced = path.join(root, "replaced");
      const alias = path.join(root, "discovery");
      for (const dir of [approved, replaced]) {
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, "SKILL.md"), "# Fixture");
      }
      fs.symlinkSync(
        approved,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      const grants = snapshotManagedSkillGrants({
        mode: "allowlist",
        configured: ["cindy:learn"],
        catalog: [
          {
            name: "learn",
            runtimeCommandName: "cindy:learn",
            path: path.join(alias, "SKILL.md"),
            enabled: true,
          },
        ],
      });
      expect(grants?.has(canonicalSkillPath(approved))).toBe(true);
      fs.unlinkSync(alias);
      fs.symlinkSync(
        replaced,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(grants?.has(canonicalSkillPath(alias))).toBe(false);
      expect(grants?.has(canonicalSkillPath(approved))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
