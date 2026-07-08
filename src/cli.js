#!/usr/bin/env node
import { Command } from "commander";
import { mkdir, writeFile, access } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
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
  .version(pkg.version)
  .showHelpAfterError();

program.addHelpText(
  "after",
  `
Examples:
  $ keymaker score https://petstore3.swagger.io/api/v3/openapi.json   grade a spec's agent-readiness
  $ keymaker doctor stripe.com yourapi.com                            check live sites for agent surfaces
  $ keymaker generate ./openapi.yaml -o agent-ready                   emit MCP server + llms.txt + auth.md
  $ keymaker serve agent-ready                                        run agent signup + hosted /mcp
  $ keymaker improve ./openapi.yaml                                   have Claude draft missing docs
  $ keymaker keys agent-ready                                         list issued agent keys
`
);

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
            mcp_requests_per_minute_per_key: 60,
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
  .command("improve")
  .argument("<spec>", "OpenAPI spec path or URL")
  .description("Draft missing summaries and descriptions with Claude, write an improved spec")
  .option("-o, --out <file>", "output file (default: <name>.improved.<yaml|json>)")
  .option("--model <model>", "Claude model to use", "claude-opus-4-8")
  .action(async (specSrc, opts) => {
    const { collectGaps, draftDescriptions, applyDescriptions } = await import("./improve.js");
    const yaml = (await import("js-yaml")).default;
    const { writeFile } = await import("node:fs/promises");

    const spec = await loadSpec(specSrc);
    const beforeExtract = extractOperations(spec);
    const before = scoreSpec(spec, beforeExtract.ops, beforeExtract.warnings);

    const gaps = collectGaps(spec);
    const total = gaps.operations.length + gaps.parameters.length;
    if (!total) {
      console.log(`Nothing to improve — every operation and parameter is documented (${before.total}/100).`);
      return;
    }
    console.log(`Drafting docs for ${gaps.operations.length} operation(s) and ${gaps.parameters.length} parameter(s) with ${opts.model}…`);

    let drafts;
    try {
      drafts = await draftDescriptions(gaps, { model: opts.model });
    } catch (err) {
      if (/api.?key|auth/i.test(String(err?.message))) {
        console.error("Claude API credentials needed: set ANTHROPIC_API_KEY, or run `ant auth login`.");
        process.exit(1);
      }
      throw err;
    }

    const applied = applyDescriptions(spec, drafts);
    const isJson = /\.json($|\?)/.test(specSrc);
    const base = specSrc.split("/").pop().replace(/\.(json|ya?ml)$/, "");
    const outFile = opts.out ?? `${base}.improved.${isJson ? "json" : "yaml"}`;
    await writeFile(outFile, isJson ? JSON.stringify(spec, null, 2) : yaml.dump(spec, { lineWidth: 100 }));

    const afterExtract = extractOperations(spec);
    const after = scoreSpec(spec, afterExtract.ops, afterExtract.warnings);
    console.log(`✔ Applied ${applied} drafted description(s) → ${outFile}`);
    console.log(`Agent-readiness: ${before.total}/100 → ${after.total}/100 (${after.grade})`);
    console.log(`Review the drafts before shipping — they're derived from names and paths, not your implementation.`);
  });

program
  .command("doctor")
  .argument("<hosts...>", "domain(s) to check, e.g. api.example.com docs.example.com")
  .description("Check a LIVE site for agent surfaces: llms.txt, auth.md, /mcp")
  .option("--json", "machine-readable output")
  .action(async (hosts, opts) => {
    const { checkSite, formatDoctor } = await import("./doctor.js");
    const results = [];
    for (const host of hosts) {
      const r = await checkSite(host);
      results.push(r);
      if (!opts.json) console.log(formatDoctor(r));
    }
    if (opts.json) console.log(JSON.stringify(results, null, 2));
    const invisible = results.filter((r) => !r.llms_txt && !r.auth_md && !r.mcp).length;
    if (!opts.json && results.length > 1) {
      console.log(`\n${invisible}/${results.length} hosts have zero agent surfaces. keymaker generate fixes all three.`);
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

program
  .command("cloud")
  .description("Run the hosted multi-tenant platform (vendors provision from a spec, get live agent endpoints)")
  .option("-p, --port <port>", "port", process.env.PORT ?? "8080")
  .option("--data <dir>", "data root", process.env.KEYMAKER_DATA ?? "data")
  .option("--public-url <url>", "public origin (for URLs in responses)", process.env.PUBLIC_URL)
  .action(async (opts) => {
    const { startCloud } = await import("./cloud.js");
    const server = await startCloud({ dataRoot: opts.data, port: Number(opts.port), publicUrl: opts.publicUrl });
    const url = opts.publicUrl ?? `http://localhost:${server.address().port}`;
    console.log(`Keymaker Cloud on ${url}`);
    console.log(`  GET  /                    landing + provision form`);
    console.log(`  POST /v1/tenants          {name, spec_url} → live agent endpoints`);
    console.log(`  ALL  /t/<id>/…            per-tenant agent-auth, mcp, auth.md, llms.txt, OAuth`);
    console.log(`  GET  /t/<id>/dashboard    keys + usage (needs admin_token)`);
  });

program
  .command("billing-init")
  .description("Create the Stripe meter + metered price for agent billing (test mode works)")
  .option("--per-call-usd <usd>", "price per metered agent request in USD", "0.001")
  .action(async (opts) => {
    const { initStripeBilling } = await import("./billing.js");
    try {
      const r = await initStripeBilling({ perCallUsd: Number(opts.perCallUsd) });
      console.log("✔ Stripe billing wired:");
      console.log(`  meter    ${r.meter_id}  (event: ${r.event_name})`);
      console.log(`  product  ${r.product_id}`);
      console.log(`  price    ${r.price_id}  ($${opts.perCallUsd}/call, monthly invoice)`);
      console.log(`\nAdd to signup.config.json:`);
      console.log(`  "billing": { "provider": "stripe", "meter_event_name": "${r.event_name}" }`);
      console.log(`\nThen subscribe an agent's Stripe customer to ${r.price_id} and its usage becomes invoices.`);
    } catch (err) {
      console.error(String(err?.message ?? err));
      process.exit(1);
    }
  });

program
  .command("keys")
  .argument("[dir]", "generated directory", "agent-ready")
  .description("List issued agent keys, or revoke one")
  .option("--revoke <key_id>", "revoke the key with this id")
  .action(async (dir, opts) => {
    const { readKeys, writeKeys } = await import("./store.js");
    const keys = await readKeys(dir);
    if (opts.revoke) {
      if (!keys[opts.revoke]) {
        console.error(`No such key: ${opts.revoke}`);
        process.exit(1);
      }
      keys[opts.revoke].revoked = true;
      await writeKeys(dir, keys);
      console.log(`✔ revoked ${opts.revoke}`);
      return;
    }
    const list = Object.values(keys).filter((k) => k.type !== "oauth_client");
    if (!list.length) {
      console.log("No keys issued yet. Agents register via POST /agent-auth.");
      return;
    }
    for (const k of list) {
      const state = k.revoked
        ? "revoked"
        : k.expires_at && Date.parse(k.expires_at) < Date.now()
          ? "expired"
          : k.status;
      console.log(
        `${k.key_id}  ${k.key_prefix}…  ${String(state).padEnd(14)} scopes=${k.scopes.join(",")}  usage=${k.usage}  created=${k.created_at}`
      );
    }
  });

program.parse();
