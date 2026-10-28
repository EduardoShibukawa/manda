import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function manda(...args: string[]) {
  const r = Bun.spawnSync(["bun", "bin/manda.ts", ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("manda CLI mínima", () => {
  test("version --json imprime o contrato v1", () => {
    const r = manda("version", "--json");
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.schema_version).toBe(1);
    expect(j.name).toBe("manda");
    expect(typeof j.version).toBe("string");
  });

  test("comando desconhecido sai com 2", () => {
    expect(manda("nao-existe").code).toBe(2);
  });

  test("package.json expõe os bins manda e mandacaru", () => {
    const p = join(ROOT, "package.json");
    expect(existsSync(p)).toBe(true);
    const pkg = JSON.parse(readFileSync(p, "utf8"));
    expect(pkg.bin?.manda).toBe("bin/manda.ts");
    expect(pkg.bin?.mandacaru).toBe("bin/manda.ts");
  });

  test("README tem Name origin e cita Manda-CARU", () => {
    const p = join(ROOT, "README.md");
    expect(existsSync(p)).toBe(true);
    const txt = readFileSync(p, "utf8");
    expect(txt).toMatch(/^#+\s*Name origin/m);
    expect(txt).toContain("Manda-CARU");
  });

  test("sem dependência de @earendil-works/*, p-inga ou ginga", () => {
    const p = join(ROOT, "package.json");
    expect(existsSync(p)).toBe(true);
    const pkg = JSON.parse(readFileSync(p, "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies });
    expect(deps.filter((d) => /^@earendil-works\//.test(d) || /^(p-inga|pinga|ginga)$/.test(d))).toEqual([]);
    const r = Bun.spawnSync(
      ["grep", "-rEn", "(import|export|require).*(@earendil-works|p-inga|pi-harness|\\.\\./ginga)", "src", "bin"],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    expect(r.stdout.toString().trim()).toBe("");
    expect(existsSync(join(ROOT, "src", "cli.ts"))).toBe(true);
  });
});
