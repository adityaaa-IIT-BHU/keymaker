#!/usr/bin/env node
import { Command } from "commander";
import { mkdir, writeFile, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadSpec } from "./parse.js";
import { extractOperations } from "./extract.js";
import { renderMcpServer, toTools } from "./gen-mcp.js";
import { renderLlmsTxt } from "./gen-llms.js";
import { renderAuthMd } from "./gen-authmd.js";
import { startSignupServer } from "./serve.js";
import { scoreSpec } from "./score.js";

const program = new Command();
program
  .name("keymaker")
  .description("Make your API agent-ready: OpenAPI → curated MCP server + llms.txt + auth.md agent signup")
  .version("0.1.0");

program
  .command("generate")
  .argument("<spec>", "OpenAPI spec path or URL (JSON or YAML)")
  .option("-o, --out <dir>", "output directory", "agent-ready")
  .option("--base-url <url>", "override API base URL")
  .option("--service-url <url>", "public URL where the signup server runs", "http://localhost:8787")
  .option("--include <names...>", "only operations whose name contains one of these")
  .option("--exclude <names...>", "skip operations whose name contains one of these")
  .action(async (specSrc, opts) => {
    const spec = await loadSpec(specSrc);
    const baseUrl = (opts.baseUrl ?? spec.servers?.[0]?.url ?? "http://localhost:3000").replace(/\/$/, "");
    const { ops, warnings } = extractOperations(spec, { include: opts.include, exclude: opts.exclude });
    if (!ops.length) {
      console.error("No operations found in spec (check --include/--exclude filters).");
      process.exit(1);
    }
    const title = spec.info?.title ?? "api";
    await mkdir(join(opts.out, ".well-known"), { recursive: true });
    const authMd = renderAuthMd({ spec, serviceUrl: opts.serviceUrl });
    await writeFile(
      join(opts.out, "mcp-server.mjs"),
      renderMcpServer({ title, version: spec.info?.version ?? "0.0.0", baseUrl, ops })
    );
    await writeFile(join(opts.out, "llms.txt"), renderLlmsTxt({ spec, ops, baseUrl, serviceUrl: opts.serviceUrl }));
    await writeFile(join(opts.out, "auth.md"), authMd);
    await writeFile(join(opts.out, ".well-known", "auth.md"), authMd);
    await writeFile(
      join(opts.out, "tools.json"),
      JSON.stringify(
        { title, version: spec.info?.version ?? "0.0.0", baseUrl, tools: toTools(ops) },
        null,
        2
      )
    );

    const configPath = join(opts.out, "signup.config.json");
    try {
      await access(configPath);
    } catch {
      await writeFile(
        configPath,
        JSON.stringify(
          {
            _note:
              "dev_accept_any_attestation accepts ANY attestation string — local testing only. For production, set trusted_issuers: [{ issuer, jwks_url }] and remove the dev flag.",
            dev_accept_any_attestation: true,
            audience: null,
            trusted_issuers: [],
            registrations_per_minute_per_ip: 10,
            verifies_per_minute_per_key: 120,
            admin_token: `adm_${randomBytes(16).toString("hex")}`,
          },
          null,
          2
        )
      );
    }

    console.log(`✔ ${title}: ${ops.length} operations → ${opts.out}/`);
    console.log("  mcp-server.mjs   llms.txt   auth.md   .well-known/auth.md   tools.json   signup.config.json");
    if (warnings.length) {
      console.log("\nCuration report — agents choose tools by docs quality; fix these in your spec:");
      for (const w of warnings.slice(0, 20)) console.log(`  ⚠ ${w}`);
      if (warnings.length > 20) console.log(`  …and ${warnings.length - 20} more`);
    }
    if (ops.length > 40) {
      console.log(
        `\n⚠ ${ops.length} tools is tool-explosion territory — agents pick tools better from small, curated sets.` +
          `\n  Narrow it: keymaker generate <spec> --include <names…>   (or --exclude)`
      );
    }
    const { total, grade } = scoreSpec(spec, ops, warnings);
    console.log(`\nAgent-readiness score: ${total}/100 (${grade}) — run \`keymaker score\` for the breakdown`);
    console.log(`\nNext:`);
    console.log(`  keymaker serve ${opts.out}                # agent-signup endpoint`);
    console.log(`  node ${join(opts.out, "mcp-server.mjs")}   # MCP server (stdio)`);
  });

program
  .command("score")
  .argument("<spec>", "OpenAPI spec path or URL")
  .description("Grade how agent-ready an API spec is (like Lighthouse, for agents)")
  .option("--json", "machine-readable output")
  .option("--min <score>", "exit non-zero if the score is below this (for CI)")
  .action(async (specSrc, opts) => {
    const spec = await loadSpec(specSrc);
    const { ops, warnings } = extractOperations(spec);
    const { total, grade, parts } = scoreSpec(spec, ops, warnings);
    if (opts.json) {
      console.log(JSON.stringify({ title: spec.info?.title ?? "API", operations: ops.length, total, grade, parts }, null, 2));
    } else {
      console.log(`Agent-readiness: ${total}/100  grade ${grade}   (${spec.info?.title ?? "API"}, ${ops.length} operations)\n`);
      for (const p of parts) {
        const bar = "█".repeat(Math.round((10 * p.got) / p.max)).padEnd(10, "░");
        console.log(`  ${bar} ${String(p.got).padStart(3)}/${p.max}  ${p.name}${p.fix ? `  → ${p.fix}` : ""}`);
      }
      console.log(`\nAgents choose tools by documentation quality. Fix the arrows, re-run, ship.`);
    }
    if (opts.min && total < Number(opts.min)) {
      console.error(`\n✖ score ${total} is below --min ${opts.min}`);
      process.exit(1);
    }
  });

program
  .command("serve")
  .argument("[dir]", "generated directory", "agent-ready")
  .option("-p, --port <port>", "port", "8787")
  .action(async (dir, opts) => {
    const server = await startSignupServer({ dir, port: Number(opts.port) });
    const port = server.address().port;
    console.log(`Agent signup live on http://localhost:${port}`);
    console.log(`  GET  /auth.md            registration instructions (also /.well-known/auth.md, /llms.txt)`);
    console.log(`  POST /agent-auth         agent registers, gets a scoped key (temp until claimed, or attested)`);
    console.log(`  POST /agent-auth/claim   human claims a temporary key`);
    console.log(`  POST /agent-auth/verify  your backend verifies keys + meters usage`);
    console.log(`  GET  /agent-auth/keys    issued keys (redacted)`);
  });

program.parse();
