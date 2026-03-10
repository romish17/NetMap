import { useEffect, useRef } from "react";
import * as d3 from "d3";
import { NC, EDGE_COLORS, getNodeConfig } from "../lib/nodeConfig.js";

export default function TopologyGraph({ topology, selected, onSelect }) {
  const svgRef  = useRef(null);
  const simRef  = useRef(null);
  const hullRef = useRef(null);

  useEffect(() => {
    if (!topology || !svgRef.current) return;

    const el = svgRef.current;
    const W  = el.clientWidth  || 1000;
    const H  = el.clientHeight || 700;

    d3.select(el).selectAll("*").remove();
    if (simRef.current) simRef.current.stop();

    const svg = d3.select(el);

    // ── Defs ──
    const defs = svg.append("defs");

    Object.entries(NC).forEach(([type, c]) => {
      const f = defs.append("filter").attr("id", `glow-${type}`)
        .attr("x", "-80%").attr("y", "-80%").attr("width", "260%").attr("height", "260%");
      f.append("feGaussianBlur").attr("in", "SourceGraphic").attr("stdDeviation", type === "proxmox" ? 6 : 3.5).attr("result", "b");
      const m = f.append("feMerge");
      m.append("feMergeNode").attr("in", "b");
      m.append("feMergeNode").attr("in", "SourceGraphic");
    });

    const radial = defs.append("radialGradient").attr("id", "bg-grad").attr("cx", "50%").attr("cy", "50%").attr("r", "75%");
    radial.append("stop").attr("offset", "0%").attr("stop-color", "#0c0c28");
    radial.append("stop").attr("offset", "100%").attr("stop-color", "#03030e");

    const pat = defs.append("pattern").attr("id", "grid").attr("width", 48).attr("height", 48).attr("patternUnits", "userSpaceOnUse");
    pat.append("path").attr("d", "M48 0L0 0L0 48").attr("fill", "none").attr("stroke", "#00f7ff04").attr("stroke-width", "0.5");

    svg.append("rect").attr("width", W).attr("height", H).attr("fill", "url(#bg-grad)");
    svg.append("rect").attr("width", W).attr("height", H).attr("fill", "url(#grid)");

    const g = svg.append("g");

    svg.call(d3.zoom().scaleExtent([0.08, 8]).on("zoom", e => g.attr("transform", e.transform)));
    svg.on("click.bg", () => onSelect(null));

    const hullG = g.append("g").attr("class", "hulls");
    hullRef.current = hullG;

    const parentGroups = {};
    for (const n of topology.nodes) {
      if (n.parent) {
        if (!parentGroups[n.parent]) parentGroups[n.parent] = [];
        parentGroups[n.parent].push(n.id);
      }
    }

    const nodes   = topology.nodes.map(n => ({ ...n }));
    const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]));
    const links   = topology.edges
      .filter(e => nodeMap[e.source] && nodeMap[e.target])
      .map(e => ({ ...e }));

    const sim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id(d => d.id)
        .distance(d => d.type === "hypervisor_vm" ? 120 : d.type === "vm_agent" ? 60 : 70)
        .strength(d => d.type === "vm_agent" ? 1.2 : d.type === "vm_container" ? 1.0 : 0.7)
      )
      .force("charge", d3.forceManyBody().strength(d => {
        if (d.type === "proxmox")   return -900;
        if (d.type === "container") return -250;
        return -550;
      }))
      .force("center",  d3.forceCenter(W / 2, H / 2))
      .force("collide", d3.forceCollide().radius(d => (getNodeConfig(d.type).r ?? 18) + 28));

    simRef.current = sim;

    const linkSel = g.append("g").selectAll("line").data(links).join("line")
      .attr("stroke", d => EDGE_COLORS[d.type] ?? "#334a6a")
      .attr("stroke-width", d => d.type === "hypervisor_vm" ? 2 : d.type === "vm_agent" ? 1.5 : 1)
      .attr("stroke-opacity", d => d.type === "vm_container" ? 0.35 : 0.5)
      .attr("stroke-dasharray", d => d.type === "vm_agent" ? "4 3" : null);

    const nodeSel = g.append("g").selectAll("g").data(nodes).join("g")
      .attr("class", "node")
      .call(d3.drag()
        .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag",  (e, d) => { d.fx = e.x; d.fy = e.y; })
        .on("end",   (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })
      )
      .style("cursor", "pointer")
      .on("click", (e, d) => { e.stopPropagation(); onSelect(d); });

    nodeSel.each(function(d) {
      const g2    = d3.select(this);
      const c     = getNodeConfig(d.type);
      const r     = c.r;
      const stale   = d.stale;
      const noAgent = d.hasAgent === false;

      if (d.type === "proxmox") {
        const hex = (r2, ang = 0) =>
          Array.from({ length: 6 }, (_, i) => {
            const a = (Math.PI / 3) * i + ang;
            return `${Math.cos(a) * r2},${Math.sin(a) * r2}`;
          }).join(" ");
        g2.append("polygon").attr("points", hex(r + 10)).attr("fill", "none")
          .attr("stroke", c.color).attr("stroke-width", 0.5).attr("opacity", 0.15);
        g2.append("polygon").attr("points", hex(r)).attr("fill", "#03030e")
          .attr("stroke", c.color).attr("stroke-width", 2.5)
          .style("filter", `url(#glow-${d.type})`);
        g2.append("polygon").attr("points", hex(r - 2)).attr("fill", c.color).attr("opacity", 0.07);
      } else {
        g2.append("circle").attr("r", r + 10).attr("fill", "none")
          .attr("stroke", stale ? "#334a6a" : c.color)
          .attr("stroke-width", 0.5)
          .attr("opacity", noAgent ? 0.06 : 0.12);
        g2.append("circle").attr("r", r)
          .attr("fill", "#03030e")
          .attr("stroke", stale ? "#334a6a" : c.color)
          .attr("stroke-width", noAgent ? 1 : d.type === "container" ? 1 : 2)
          .attr("stroke-dasharray", (stale || noAgent) ? "3 2" : null)
          .style("filter", stale ? null : `url(#glow-${d.type})`);
        g2.append("circle").attr("r", r - 2)
          .attr("fill", stale ? "#334a6a" : c.color).attr("opacity", 0.07);
      }

      g2.append("text")
        .attr("text-anchor", "middle").attr("dominant-baseline", "central")
        .attr("fill", stale ? "#334a6a" : c.color)
        .attr("font-size", `${Math.round(r * 0.46)}px`)
        .attr("font-family", "'Azeret Mono', monospace").attr("font-weight", "500")
        .text(c.symbol);

      const labelY = r + 15;
      g2.append("text")
        .attr("text-anchor", "middle").attr("y", labelY)
        .attr("fill", stale ? "#2a3a50" : "#c8d8e8")
        .attr("font-size", d.type === "container" ? "8px" : "9px")
        .attr("font-family", "'Azeret Mono', monospace")
        .attr("letter-spacing", "1")
        .text(d.label);

      if (d.type !== "container" && d.ip) {
        g2.append("text")
          .attr("text-anchor", "middle").attr("y", labelY + 12)
          .attr("fill", stale ? "#1a2a3a" : c.color).attr("opacity", 0.55)
          .attr("font-size", "7.5px")
          .attr("font-family", "'Azeret Mono', monospace")
          .text(d.ip);
      }

      // "NO AGENT" badge for scanned nodes without an agent
      if (noAgent) {
        const badgeX = r - 2;
        const badgeY = -(r - 2);
        g2.append("rect")
          .attr("x", badgeX - 16).attr("y", badgeY - 7)
          .attr("width", 32).attr("height", 12)
          .attr("fill", "#ff2d78").attr("rx", 1);
        g2.append("text")
          .attr("x", badgeX).attr("y", badgeY - 1)
          .attr("text-anchor", "middle").attr("dominant-baseline", "middle")
          .attr("fill", "#fff").attr("font-size", "5px").attr("font-weight", "bold")
          .attr("font-family", "'Azeret Mono', monospace").attr("letter-spacing", "1")
          .text("NO AGENT");
      }

      if (stale && !noAgent) {
        g2.append("circle").attr("r", 5).attr("cx", r - 2).attr("cy", -(r - 2))
          .attr("fill", "#ff2d78").attr("stroke", "#03030e").attr("stroke-width", 1.5);
        g2.append("text")
          .attr("x", r - 2).attr("y", -(r - 2))
          .attr("text-anchor", "middle").attr("dominant-baseline", "central")
          .attr("fill", "#03030e").attr("font-size", "6px").attr("font-weight", "bold")
          .text("!");
      }
    });

    function drawHulls() {
      hullG.selectAll("path").remove();
      for (const [parentId, childIds] of Object.entries(parentGroups)) {
        const parent = nodeMap[parentId];
        if (!parent || parent.x == null) continue;
        const pts = [
          [parent.x, parent.y],
          ...childIds.map(cid => {
            const cn = nodeMap[cid];
            return cn?.x != null ? [cn.x, cn.y] : null;
          }).filter(Boolean),
        ];
        if (pts.length < 3) continue;
        const hull = d3.polygonHull(pts);
        if (!hull) continue;
        const nc = getNodeConfig(parent.type);
        const padded = hull.map(([x, y]) => {
          const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
          const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
          const dx = x - cx, dy = y - cy;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          return [cx + (dx / dist) * (dist + 42), cy + (dy / dist) * (dist + 42)];
        });
        hullG.append("path")
          .attr("d", `M${padded.join("L")}Z`)
          .attr("fill", nc.color)
          .attr("fill-opacity", 0.025)
          .attr("stroke", nc.color)
          .attr("stroke-opacity", 0.12)
          .attr("stroke-width", 1)
          .attr("stroke-dasharray", "6 4");
      }
    }

    sim.on("tick", () => {
      linkSel
        .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      nodeSel.attr("transform", d => `translate(${d.x ?? 0},${d.y ?? 0})`);
      drawHulls();
    });

    return () => sim.stop();
  }, [topology]);

  return <svg ref={svgRef} style={{ width: "100%", height: "100%", display: "block" }} />;
}
