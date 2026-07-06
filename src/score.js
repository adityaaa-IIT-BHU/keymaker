export function scoreSpec(spec, ops, warnings) {
  const totalOps = ops.length || 1;
  const docWarn = warnings.filter((w) => w.includes("no summary or description")).length;
  const paramWarn = warnings.filter((w) => w.includes("has no description")).length;
  const totalParams = ops.reduce(
    (n, o) => n + Object.values(o.paramLocs).filter((l) => l !== "body").length,
    0
  );

  const parts = [];
  parts.push({
    name: "Operation docs",
    got: Math.round((40 * (totalOps - docWarn)) / totalOps),
    max: 40,
    fix: docWarn ? `${docWarn} operation(s) missing summary/description` : null,
  });
  parts.push({
    name: "Parameter docs",
    got: totalParams ? Math.round((20 * Math.max(0, totalParams - paramWarn)) / totalParams) : 20,
    max: 20,
    fix: paramWarn ? `${paramWarn} parameter(s) undocumented` : null,
  });
  parts.push({
    name: "API description",
    got: spec.info?.description ? 10 : 0,
    max: 10,
    fix: spec.info?.description ? null : "add info.description",
  });
  const server = spec.servers?.[0]?.url ?? "";
  const absolute = /^https?:\/\//.test(server);
  parts.push({
    name: "Absolute base URL",
    got: absolute ? 10 : 0,
    max: 10,
    fix: absolute ? null : "servers[0].url should be an absolute https URL",
  });
  const schemes = Object.values(spec.components?.securitySchemes ?? {});
  const schemesDescribed = schemes.length && schemes.every((s) => s.description);
  parts.push({
    name: "Documented auth",
    got: schemes.length ? (schemesDescribed ? 10 : 5) : 0,
    max: 10,
    fix: !schemes.length
      ? "declare components.securitySchemes"
      : schemesDescribed
        ? null
        : "add descriptions to security schemes",
  });
  const tagged = ops.filter((o) => o.tags.length).length;
  parts.push({
    name: "Tagged operations",
    got: Math.round((10 * tagged) / totalOps),
    max: 10,
    fix: tagged === totalOps ? null : "tag all operations for grouping",
  });

  const total = parts.reduce((n, p) => n + p.got, 0);
  const grade = total >= 90 ? "A" : total >= 75 ? "B" : total >= 60 ? "C" : total >= 40 ? "D" : "F";
  return { total, grade, parts };
}
