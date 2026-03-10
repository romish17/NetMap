import { useState, useEffect, useRef, useCallback } from "react";
import * as d3 from "d3";

// ─── Config ──────────────────────────────────────────────────────────────────

const API  = import.meta.env?.VITE_API_URL  ?? "http://localhost:3000";
const WS   = import.meta.env?.VITE_WS_URL   ?? "ws://localhost:3000/ws";

// ─── Mock topology (used when API is unreachable) ─────────────────────────────

const MOCK = {
  nodes: [
    // Proxmox host
    { id: "proxmox/pve", label: "PVE-HOME", type: "proxmox", ip: "192.168.1.200", stale: false,
      detail: { proxmox: { cpu: 0.08, maxmem: 34359738368, mem: 18000000000, uptime: 864000, node: "pve" } } },

    // VMs under Proxmox
    { id: "proxmox/pve/100", label: "netmap-srv",  type: "vm",  vmid: 100, parent: "proxmox/pve", ip: "192.168.1.10", status: "running", stale: false, detail: { vm: { name: "netmap-srv", vmid: 100, status: "running", cpu: 0.02, maxmem: 2147483648, mem: 512000000 } } },
    { id: "proxmox/pve/101", label: "traefik",     type: "vm",  vmid: 101, parent: "proxmox/pve", ip: "192.168.1.11", status: "running", stale: false, detail: { vm: { name: "traefik",    vmid: 101, status: "running", cpu: 0.01, maxmem: 1073741824, mem: 256000000 } } },
    { id: "proxmox/pve/102", label: "gitea",       type: "vm",  vmid: 102, parent: "proxmox/pve", ip: "192.168.1.12", status: "running", stale: false, detail: { vm: {} } },
    { id: "proxmox/pve/200", label: "pihole-lxc",  type: "lxc", vmid: 200, parent: "proxmox/pve", ip: "192.168.1.53", status: "running", stale: false, detail: { vm: {} } },

    // Agents matching VMs
    { id: "netmap-srv",  label: "netmap-srv",  type: "agent", ip: "192.168.1.10", os: "Debian 12",        stale: false, last_seen: Date.now() - 5000,
      detail: { system: { os: "Debian 12", cpu_cores: 2, ram_total_mb: 2048, ram_used_mb: 520, uptime_secs: 86400, kernel: "6.1.0-18-amd64" }, interfaces: [{ name: "eth0", ip: "192.168.1.10", mac: "52:54:00:ab:01:10", cidr: "/24" }], open_ports: [{ port: 3000, proto: "tcp", process: "node", state: "LISTEN" }, { port: 22, proto: "tcp", process: "sshd", state: "LISTEN" }], shares: { smb: [], nfs: [] },
        docker: { available: true, version: "24.0.7", containers: [
          { id: "a1b2c3", name: "netmap-server",  image: "netmap-server:latest", state: "running", status: "Up 3h", ports: [{ host_port: 3000, container_port: 3000, proto: "tcp" }], networks: ["netmap_net"] },
          { id: "d4e5f6", name: "sqlite-web",     image: "coleifer/sqlite-web",  state: "running", status: "Up 3h", ports: [{ host_port: 8080, container_port: 8080, proto: "tcp" }], networks: ["netmap_net"] },
        ]} } },
    { id: "traefik",     label: "traefik",     type: "agent", ip: "192.168.1.11", os: "Alpine 3.19",      stale: false, last_seen: Date.now() - 12000,
      detail: { system: { os: "Alpine Linux 3.19", cpu_cores: 2, ram_total_mb: 1024, ram_used_mb: 120, uptime_secs: 172800, kernel: "6.1.0-18-amd64" }, interfaces: [{ name: "eth0", ip: "192.168.1.11", mac: "52:54:00:ab:01:11", cidr: "/24" }], open_ports: [{ port: 80, proto: "tcp", process: "traefik", state: "LISTEN" }, { port: 443, proto: "tcp", process: "traefik", state: "LISTEN" }, { port: 8080, proto: "tcp", process: "traefik", state: "LISTEN" }], shares: { smb: [], nfs: [] },
        docker: { available: true, version: "24.0.7", containers: [
          { id: "t1r2k3", name: "traefik",         image: "traefik:v2.11",         state: "running", status: "Up 2d", ports: [{ host_port: 80, container_port: 80, proto: "tcp" }, { host_port: 443, container_port: 443, proto: "tcp" }], networks: ["proxy"] },
          { id: "w1h2o3", name: "whoami",           image: "traefik/whoami",         state: "running", status: "Up 2d", ports: [{ host_port: 8081, container_port: 80, proto: "tcp"  }], networks: ["proxy"] },
        ]} } },

    // VPS en ligne (agent only, no Proxmox parent)
    { id: "vps-ovh-01", label: "VPS-OVH-01", type: "agent", ip: "51.68.102.77",  os: "Ubuntu 22.04", stale: false, last_seen: Date.now() - 8000,
      detail: { system: { os: "Ubuntu 22.04.6 LTS", cpu_cores: 4, ram_total_mb: 4096, ram_used_mb: 1200, uptime_secs: 2592000, kernel: "5.15.0-101-generic" }, interfaces: [{ name: "ens3", ip: "51.68.102.77", mac: "fa:16:3e:ab:cd:ef", cidr: "/32" }], open_ports: [{ port: 22, proto: "tcp", process: "sshd", state: "LISTEN" }, { port: 80, proto: "tcp", process: "nginx", state: "LISTEN" }, { port: 443, proto: "tcp", process: "nginx", state: "LISTEN" }], shares: { smb: [], nfs: [{ path: "/exports/www", clients: "192.168.1.0/24", options: "ro,sync" }] },
        docker: { available: true, version: "25.0.3", containers: [
          { id: "ng1nx2", name: "nginx",     image: "nginx:1.25",          state: "running", status: "Up 30d", ports: [{ host_port: 80,  container_port: 80,  proto: "tcp" }, { host_port: 443, container_port: 443, proto: "tcp" }], networks: ["web"] },
          { id: "wg1rd2", name: "wireguard", image: "linuxserver/wireguard", state: "running", status: "Up 30d", ports: [{ host_port: 51820, container_port: 51820, proto: "udp" }], networks: ["host"] },
          { id: "ps1ql2", name: "postgres",  image: "postgres:16",          state: "running", status: "Up 30d", ports: [], networks: ["internal"] },
        ]} } },

    // NAS (no agent, just nmap-discovered)
    { id: "nas-synology", label: "NAS-DS923+", type: "nas", ip: "192.168.1.50", stale: false,
      detail: { open_ports: [{ port: 80, proto: "tcp", process: "" }, { port: 443, proto: "tcp", process: "" }, { port: 445, proto: "tcp", process: "" }, { port: 5000, proto: "tcp", process: "" }, { port: 5001, proto: "tcp", process: "" }], shares: { smb: [{ name: "backups", path: "/volume1/backups", comment: "VM Backups" }, { name: "media", path: "/volume1/media", comment: "Plex Media" }], nfs: [{ path: "/volume1/data", clients: "192.168.1.0/24", options: "rw,sync,no_subtree_check" }] } } },

    // Docker containers (children of agents)
    { id: "docker::netmap-srv::a1b2c3", label: "netmap-server", type: "container", image: "netmap-server:latest", state: "running", parent: "netmap-srv",  detail: { container: { id: "a1b2c3", name: "netmap-server", image: "netmap-server:latest", state: "running", ports: [{ host_port: 3000, container_port: 3000, proto: "tcp" }], networks: ["netmap_net"] } } },
    { id: "docker::netmap-srv::d4e5f6", label: "sqlite-web",    type: "container", image: "coleifer/sqlite-web",  state: "running", parent: "netmap-srv",  detail: { container: { id: "d4e5f6", name: "sqlite-web",    image: "coleifer/sqlite-web",  state: "running", ports: [{ host_port: 8080, container_port: 8080, proto: "tcp" }], networks: ["netmap_net"] } } },
    { id: "docker::traefik::t1r2k3",    label: "traefik",        type: "container", image: "traefik:v2.11",        state: "running", parent: "traefik",     detail: { container: { id: "t1r2k3", name: "traefik",     image: "traefik:v2.11",        state: "running", ports: [{ host_port: 80, container_port: 80, proto: "tcp" }], networks: ["proxy"] } } },
    { id: "docker::traefik::w1h2o3",    label: "whoami",          type: "container", image: "traefik/whoami",       state: "running", parent: "traefik",     detail: { container: {} } },
    { id: "docker::vps-ovh-01::ng1nx2", label: "nginx",           type: "container", image: "nginx:1.25",           state: "running", parent: "vps-ovh-01", detail: { container: {} } },
    { id: "docker::vps-ovh-01::wg1rd2", label: "wireguard",       type: "container", image: "linuxserver/wireguard", state: "running", parent: "vps-ovh-01", detail: { container: {} } },
    { id: "docker::vps-ovh-01::ps1ql2", label: "postgres",        type: "container", image: "postgres:16",           state: "running", parent: "vps-ovh-01", detail: { container: {} } },
  ],
  edges: [
    { source: "proxmox/pve", target: "proxmox/pve/100", type: "hypervisor_vm" },
    { source: "proxmox/pve", target: "proxmox/pve/101", type: "hypervisor_vm" },
    { source: "proxmox/pve", target: "proxmox/pve/102", type: "hypervisor_vm" },
    { source: "proxmox/pve", target: "proxmox/pve/200", type: "hypervisor_vm" },
    { source: "proxmox/pve/100", target: "netmap-srv",  type: "vm_agent" },
    { source: "proxmox/pve/101", target: "traefik",     type: "vm_agent" },
    { source: "netmap-srv",  target: "docker::netmap-srv::a1b2c3", type: "vm_container" },
    { source: "netmap-srv",  target: "docker::netmap-srv::d4e5f6", type: "vm_container" },
    { source: "traefik",     target: "docker::traefik::t1r2k3",    type: "vm_container" },
    { source: "traefik",     target: "docker::traefik::w1h2o3",    type: "vm_container" },
    { source: "vps-ovh-01",  target: "docker::vps-ovh-01::ng1nx2", type: "vm_container" },
    { source: "vps-ovh-01",  target: "docker::vps-ovh-01::wg1rd2", type: "vm_container" },
    { source: "vps-ovh-01",  target: "docker::vps-ovh-01::ps1ql2", type: "vm_container" },
  ],
};

// ─── Node visual config ───────────────────────────────────────────────────────

const NC = {
  proxmox:   { color: "#f97316", symbol: "PX", r: 30 },
  vm:        { color: "#a855f7", symbol: "VM", r: 22 },
  lxc:       { color: "#8b5cf6", symbol: "LX", r: 20 },
  agent:     { color: "#00f7ff", symbol: "AG", r: 22 },
  container: { color: "#38bdf8", symbol: "DK", r: 15 },
  nas:       { color: "#fbbf24", symbol: "NS", r: 22 },
};

const EDGE_COLORS = {
  hypervisor_vm: "#f97316",
  vm_agent:      "#a78bfa",
  vm_container:  "#38bdf8",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtBytes(bytes) {
  if (!bytes) return "—";
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

function fmtUptime(secs) {
  if (!secs) return "—";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
}

function timeAgo(ts) {
  if (!ts) return "—";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)  return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Azeret+Mono:wght@300;400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{overflow:hidden;background:#03030e}
::-webkit-scrollbar{width:3px}
::-webkit-scrollbar-track{background:#070715}
::-webkit-scrollbar-thumb{background:#1a2540;border-radius:2px}
.blink{animation:blink 1.1s step-end infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
.scanline{position:absolute;top:-4px;left:0;right:0;height:4px;background:linear-gradient(to bottom,transparent,#00f7ff15,transparent);animation:scanmove 7s linear infinite;pointer-events:none;z-index:5}
@keyframes scanmove{0%{top:-4px}100%{top:100%}}
.crt{position:absolute;inset:0;pointer-events:none;z-index:4;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.045) 2px,rgba(0,0,0,0.045) 4px)}
.scan-btn{background:transparent;border:1px solid currentColor;font-family:'Azeret Mono',monospace;font-size:9px;padding:6px 18px;cursor:pointer;letter-spacing:3px;text-transform:uppercase;clip-path:polygon(8px 0%,100% 0%,calc(100% - 8px) 100%,0% 100%);transition:background 0.2s,box-shadow 0.2s;outline:none}
.scan-btn:hover:not(:disabled){background:rgba(0,247,255,0.06);box-shadow:0 0 18px rgba(0,247,255,0.25)}
.scan-btn:disabled{opacity:0.3;cursor:not-allowed}
.tag{display:inline-block;font-size:8px;padding:2px 7px;border:1px solid currentColor;clip-path:polygon(4px 0%,100% 0%,calc(100% - 4px) 100%,0% 100%);letter-spacing:2px;opacity:0.75}
.port-badge{display:inline-block;margin:2px 3px 2px 0;font-size:8px;padding:2px 6px;border:1px solid #00f7ff22;color:#00f7ff66;background:#00f7ff08;clip-path:polygon(3px 0%,100% 0%,calc(100% - 3px) 100%,0% 100%)}
.stat-val{font-family:'Orbitron',monospace;font-weight:700;font-size:15px}
.section-title{font-size:7px;letter-spacing:4px;color:#1e3050;margin-bottom:10px;text-transform:uppercase;display:flex;align-items:center;gap:8px}
.section-title::after{content:'';flex:1;height:1px;background:#00f7ff0a}
.info-label{font-size:7px;letter-spacing:3px;color:#1e3050;margin-bottom:3px;text-transform:uppercase}
.info-value{font-size:10px;color:#7a8fa8;line-height:1.5}
.container-row{padding:8px 10px;margin-bottom:6px;border:1px solid #00f7ff10;background:#00f7ff04;position:relative;cursor:pointer;transition:background 0.15s}
.container-row:hover{background:#00f7ff0a}
.state-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.legend-row{display:flex;align-items:center;gap:9px;margin-bottom:8px}
`;

// ─── Main component ───────────────────────────────────────────────────────────

export default function NetMap() {
  const svgRef    = useRef(null);
  const simRef    = useRef(null);
  const wsRef     = useRef(null);
  const hullRef   = useRef(null);
  const nodesRef  = useRef([]);
  const edgesRef  = useRef([]);

  const [selected,  setSelected]  = useState(null);
  const [topology,  setTopology]  = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [wsStatus,  setWsStatus]  = useState("disconnected"); // connected | disconnected
  const [stats,     setStats]     = useState({ agents: 0, vms: 0, containers: 0 });
  const [useMock,   setUseMock]   = useState(true);
  const [detailTab, setDetailTab] = useState("info"); // info | ports | shares | docker

  // ── Load topology ──────────────────────────────────────────────────────────
  const loadTopology = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/topology`, { signal: AbortSignal.timeout(4000) });
      const data = await res.json();
      setTopology(data);
      setUseMock(false);

      const statsRes = await fetch(`${API}/api/stats`);
      setStats(await statsRes.json());
    } catch {
      // API unreachable – use mock
      setTopology(MOCK);
      setUseMock(true);
      setStats({ agents: MOCK.nodes.filter(n => n.type === "agent").length, vms: MOCK.nodes.filter(n => n.type === "vm" || n.type === "lxc").length, containers: MOCK.nodes.filter(n => n.type === "container").length });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadTopology(); }, [loadTopology]);

  // ── WebSocket ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (useMock) return;
    const ws = new WebSocket(WS);
    wsRef.current = ws;
    ws.onopen    = () => setWsStatus("connected");
    ws.onclose   = () => setWsStatus("disconnected");
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.event === "agent_updated" || msg.event === "proxmox_updated") {
        loadTopology();
      }
    };
    return () => ws.close();
  }, [useMock, loadTopology]);

  // ── D3 graph ───────────────────────────────────────────────────────────────
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
        .attr("x","-80%").attr("y","-80%").attr("width","260%").attr("height","260%");
      f.append("feGaussianBlur").attr("in","SourceGraphic").attr("stdDeviation", type === "proxmox" ? 6 : 3.5).attr("result","b");
      const m = f.append("feMerge");
      m.append("feMergeNode").attr("in","b");
      m.append("feMergeNode").attr("in","SourceGraphic");
    });

    const radial = defs.append("radialGradient").attr("id","bg-grad").attr("cx","50%").attr("cy","50%").attr("r","75%");
    radial.append("stop").attr("offset","0%").attr("stop-color","#0c0c28");
    radial.append("stop").attr("offset","100%").attr("stop-color","#03030e");

    const pat = defs.append("pattern").attr("id","grid").attr("width",48).attr("height",48).attr("patternUnits","userSpaceOnUse");
    pat.append("path").attr("d","M48 0L0 0L0 48").attr("fill","none").attr("stroke","#00f7ff04").attr("stroke-width","0.5");

    svg.append("rect").attr("width",W).attr("height",H).attr("fill","url(#bg-grad)");
    svg.append("rect").attr("width",W).attr("height",H).attr("fill","url(#grid)");

    const g = svg.append("g");

    // ── Zoom ──
    svg.call(d3.zoom().scaleExtent([0.08, 8]).on("zoom", e => g.attr("transform", e.transform)));
    svg.on("click.bg", () => setSelected(null));

    // ── Hull groups (convex hull around children) ──
    const hullG = g.append("g").attr("class", "hulls");
    hullRef.current = hullG;

    // Identify parent groups
    const parentGroups = {};
    for (const n of topology.nodes) {
      if (n.parent) {
        if (!parentGroups[n.parent]) parentGroups[n.parent] = [];
        parentGroups[n.parent].push(n.id);
      }
    }

    // ── Build D3 nodes & links ──
    const nodes = topology.nodes.map(n => ({ ...n }));
    const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]));

    const links = topology.edges
      .filter(e => nodeMap[e.source] && nodeMap[e.target])
      .map(e => ({ ...e }));

    nodesRef.current = nodes;
    edgesRef.current = links;

    // ── Force sim ──
    const sim = d3.forceSimulation(nodes)
      .force("link",    d3.forceLink(links).id(d => d.id)
        .distance(d => {
          if (d.type === "hypervisor_vm") return 120;
          if (d.type === "vm_agent")      return 60;
          if (d.type === "vm_container")  return 70;
          return 100;
        })
        .strength(d => {
          if (d.type === "vm_agent")     return 1.2;
          if (d.type === "vm_container") return 1.0;
          return 0.7;
        })
      )
      .force("charge",  d3.forceManyBody().strength(d => {
        if (d.type === "proxmox")   return -900;
        if (d.type === "container") return -250;
        return -550;
      }))
      .force("center",  d3.forceCenter(W / 2, H / 2))
      .force("collide", d3.forceCollide().radius(d => (NC[d.type]?.r ?? 18) + 28));

    simRef.current = sim;

    // ── Links ──
    const linkSel = g.append("g").selectAll("line").data(links).join("line")
      .attr("stroke", d => EDGE_COLORS[d.type] ?? "#334a6a")
      .attr("stroke-width", d => d.type === "hypervisor_vm" ? 2 : d.type === "vm_agent" ? 1.5 : 1)
      .attr("stroke-opacity", d => d.type === "vm_container" ? 0.35 : 0.5)
      .attr("stroke-dasharray", d => d.type === "vm_agent" ? "4 3" : null);

    // ── Node groups ──
    const nodeSel = g.append("g").selectAll("g").data(nodes).join("g")
      .attr("class", "node")
      .attr("id", d => `node-${d.id.replace(/[^a-zA-Z0-9]/g, "_")}`)
      .call(d3.drag()
        .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag",  (e, d) => { d.fx = e.x; d.fy = e.y; })
        .on("end",   (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })
      )
      .style("cursor", "pointer")
      .on("click", (e, d) => {
        e.stopPropagation();
        setSelected(d);
        setDetailTab("info");
      });

    nodeSel.each(function(d) {
      const g2 = d3.select(this);
      const c  = NC[d.type] ?? { color: "#94a3b8", symbol: "?", r: 18 };
      const r  = c.radius ?? c.r;
      const stale = d.stale;

      if (d.type === "proxmox") {
        // Hexagon for Proxmox
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
        // Outer ring
        g2.append("circle").attr("r", r + 10).attr("fill", "none")
          .attr("stroke", stale ? "#334a6a" : c.color)
          .attr("stroke-width", 0.5)
          .attr("opacity", 0.12);
        // Body
        g2.append("circle").attr("r", r)
          .attr("fill", "#03030e")
          .attr("stroke", stale ? "#334a6a" : c.color)
          .attr("stroke-width", d.type === "container" ? 1 : 2)
          .attr("stroke-dasharray", stale ? "3 2" : null)
          .style("filter", stale ? null : `url(#glow-${d.type})`);
        g2.append("circle").attr("r", r - 2)
          .attr("fill", stale ? "#334a6a" : c.color).attr("opacity", 0.07);
      }

      // Symbol
      g2.append("text")
        .attr("text-anchor", "middle").attr("dominant-baseline", "central")
        .attr("fill", stale ? "#334a6a" : c.color)
        .attr("font-size", `${Math.round(r * 0.46)}px`)
        .attr("font-family", "'Azeret Mono', monospace").attr("font-weight", "500")
        .text(c.symbol);

      // Label
      const labelY = (NC[d.type]?.r ?? 18) + 15;
      g2.append("text")
        .attr("text-anchor", "middle").attr("y", labelY)
        .attr("fill", stale ? "#2a3a50" : "#c8d8e8")
        .attr("font-size", d.type === "container" ? "8px" : "9px")
        .attr("font-family", "'Azeret Mono', monospace")
        .attr("letter-spacing", "1")
        .text(d.label);

      // IP (not for containers)
      if (d.type !== "container" && d.ip) {
        g2.append("text")
          .attr("text-anchor", "middle").attr("y", labelY + 12)
          .attr("fill", stale ? "#1a2a3a" : c.color).attr("opacity", 0.55)
          .attr("font-size", "7.5px")
          .attr("font-family", "'Azeret Mono', monospace")
          .text(d.ip);
      }

      // Stale warning
      if (stale) {
        g2.append("circle").attr("r", 5).attr("cx", r - 2).attr("cy", -(r - 2))
          .attr("fill", "#ff2d78").attr("stroke", "#03030e").attr("stroke-width", 1.5);
        g2.append("text")
          .attr("x", r - 2).attr("y", -(r - 2))
          .attr("text-anchor", "middle").attr("dominant-baseline", "central")
          .attr("fill", "#03030e").attr("font-size", "6px").attr("font-weight", "bold")
          .text("!");
      }
    });

    // ── Convex hulls ──
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

        const nc = NC[parent.type] ?? { color: "#94a3b8" };
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

    // ── Tick ──
    sim.on("tick", () => {
      linkSel
        .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      nodeSel.attr("transform", d => `translate(${d.x ?? 0},${d.y ?? 0})`);
      drawHulls();
    });

    return () => sim.stop();
  }, [topology]);

  // ── Detail panel ───────────────────────────────────────────────────────────

  const renderDetail = () => {
    if (!selected) return (
      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", gap:14 }}>
        <div style={{ width:36, height:36, border:"1px solid #0d1a2d", borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center" }}>
          <span style={{ color:"#0d1a2d", fontSize:16 }}>◎</span>
        </div>
        <div style={{ fontSize:8, color:"#0d1a2d", letterSpacing:4, textAlign:"center", lineHeight:2.2 }}>
          SELECT A NODE<br/>TO INSPECT
        </div>
      </div>
    );

    const nc  = NC[selected.type] ?? { color: "#94a3b8" };
    const det = selected.detail ?? {};
    const sys = det.system ?? det.vm ?? det.proxmox ?? {};
    const ports  = det.open_ports ?? [];
    const shares = det.shares ?? {};
    const docker = det.docker ?? {};
    const container = det.container ?? {};

    const tabs = [
      { id: "info",   label: "INFO" },
      ports.length   > 0 || container.ports?.length > 0 ? { id: "ports",  label: `PORTS ${ports.length || container.ports?.length}` } : null,
      (shares.smb?.length > 0 || shares.nfs?.length > 0) ? { id: "shares", label: "SHARES" } : null,
      docker.available ? { id: "docker", label: `DOCKER ${docker.containers?.length ?? 0}` } : null,
    ].filter(Boolean);

    return (
      <div style={{ height:"100%", display:"flex", flexDirection:"column" }}>
        {/* Header */}
        <div style={{ padding:"12px 14px", borderBottom:"1px solid #00f7ff10", flexShrink:0 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8 }}>
            <div>
              <div style={{ fontFamily:"'Orbitron',monospace", fontWeight:700, fontSize:13, color: nc.color, marginBottom:5, textShadow:`0 0 12px ${nc.color}50` }}>
                {selected.label}
              </div>
              <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
                <span className="tag" style={{ color: nc.color }}>{selected.type.toUpperCase()}</span>
                {selected.stale && <span className="tag" style={{ color:"#ff2d78" }}>STALE</span>}
                {selected.status && <span className="tag" style={{ color: selected.status === "running" ? "#4ade80" : "#ff2d78" }}>{selected.status.toUpperCase()}</span>}
                {selected.state  && <span className="tag" style={{ color: selected.state  === "running" ? "#4ade80" : "#ff2d78" }}>{selected.state.toUpperCase()}</span>}
              </div>
            </div>
            <button onClick={() => setSelected(null)} style={{ background:"none", border:"none", color:"#1e3050", cursor:"pointer", fontSize:16, padding:2 }}>✕</button>
          </div>
          {selected.ip && (
            <div style={{ fontSize:9, color: nc.color, opacity:0.6, fontFamily:"'Azeret Mono',monospace" }}>{selected.ip}</div>
          )}
          {selected.last_seen && (
            <div style={{ fontSize:8, color:"#1e3050", marginTop:3 }}>last seen {timeAgo(selected.last_seen)}</div>
          )}
        </div>

        {/* Tabs */}
        {tabs.length > 1 && (
          <div style={{ display:"flex", borderBottom:"1px solid #00f7ff0a", flexShrink:0 }}>
            {tabs.map(tab => (
              <button key={tab.id} onClick={() => setDetailTab(tab.id)}
                style={{ flex:1, background:"none", border:"none", borderBottom: detailTab===tab.id ? `1px solid ${nc.color}` : "1px solid transparent", color: detailTab===tab.id ? nc.color : "#1e3050", fontSize:7, letterSpacing:2, padding:"8px 4px", cursor:"pointer", transition:"color 0.15s", marginBottom:-1 }}>
                {tab.label}
              </button>
            ))}
          </div>
        )}

        {/* Body */}
        <div style={{ flex:1, overflowY:"auto", padding:"12px 14px" }}>
          {detailTab === "info" && (
            <div>
              {/* System info */}
              {sys.os && <>
                <div className="section-title">SYSTEM</div>
                {[
                  ["OS",       sys.os ?? sys.name],
                  ["KERNEL",   sys.kernel],
                  ["ARCH",     sys.arch],
                  ["UPTIME",   sys.uptime_secs ? fmtUptime(sys.uptime_secs) : fmtUptime(sys.uptime)],
                  ["CPU CORES",sys.cpu_cores ?? sys.cpus],
                  ["RAM",      sys.ram_total_mb ? `${sys.ram_used_mb} / ${sys.ram_total_mb} MB` : sys.maxmem ? `${fmtBytes(sys.mem)} / ${fmtBytes(sys.maxmem)}` : null],
                ].filter(([,v]) => v).map(([k,v]) => (
                  <div key={k} style={{ marginBottom:8 }}>
                    <div className="info-label">{k}</div>
                    <div className="info-value">{v}</div>
                  </div>
                ))}
              </>}

              {/* Interfaces */}
              {det.interfaces?.length > 0 && <>
                <div className="section-title" style={{ marginTop:14 }}>INTERFACES</div>
                {det.interfaces.map(i => (
                  <div key={i.name} style={{ marginBottom:8 }}>
                    <div className="info-label">{i.name}</div>
                    <div className="info-value">{i.ip}{i.cidr} — {i.mac}</div>
                  </div>
                ))}
              </>}

              {/* Container info */}
              {container.image && <>
                <div className="section-title">CONTAINER</div>
                {[
                  ["IMAGE",    container.image],
                  ["ID",       container.id],
                  ["NETWORKS", container.networks?.join(", ")],
                ].filter(([,v]) => v).map(([k,v]) => (
                  <div key={k} style={{ marginBottom:8 }}>
                    <div className="info-label">{k}</div>
                    <div className="info-value">{v}</div>
                  </div>
                ))}
              </>}
            </div>
          )}

          {detailTab === "ports" && (
            <div>
              <div className="section-title">LISTENING PORTS</div>
              {(ports.length > 0 ? ports : container.ports ?? []).map((p, i) => (
                <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"6px 0", borderBottom:"1px solid #00f7ff08" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <span style={{ fontFamily:"'Orbitron',monospace", fontWeight:700, fontSize:12, color: nc.color }}>{p.port ?? p.host_port}</span>
                    <span style={{ fontSize:8, color:"#334a6a" }}>{p.proto?.toUpperCase()}</span>
                  </div>
                  <span style={{ fontSize:9, color:"#4a5f80" }}>{p.process || "—"}</span>
                </div>
              ))}
              {container.ports?.length > 0 && ports.length === 0 && container.ports.map((p, i) => (
                <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"6px 0", borderBottom:"1px solid #00f7ff08" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <span style={{ fontFamily:"'Orbitron',monospace", fontWeight:700, fontSize:12, color: nc.color }}>{p.host_port}</span>
                    <span style={{ fontSize:8, color:"#334a6a" }}>→ :{p.container_port} {p.proto?.toUpperCase()}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {detailTab === "shares" && (
            <div>
              {shares.smb?.length > 0 && <>
                <div className="section-title">SMB SHARES</div>
                {shares.smb.map((s, i) => (
                  <div key={i} style={{ marginBottom:10, paddingLeft:8, borderLeft:`2px solid ${nc.color}30` }}>
                    <div style={{ fontSize:10, color: nc.color, marginBottom:2 }}>{s.name}</div>
                    <div style={{ fontSize:9, color:"#4a5f80" }}>{s.path}</div>
                    {s.comment && <div style={{ fontSize:8, color:"#1e3050" }}>{s.comment}</div>}
                  </div>
                ))}
              </>}
              {shares.nfs?.length > 0 && <>
                <div className="section-title" style={{ marginTop:14 }}>NFS EXPORTS</div>
                {shares.nfs.map((n, i) => (
                  <div key={i} style={{ marginBottom:10, paddingLeft:8, borderLeft:`2px solid #4ade8030` }}>
                    <div style={{ fontSize:10, color:"#4ade80", marginBottom:2 }}>{n.path}</div>
                    <div style={{ fontSize:9, color:"#4a5f80" }}>clients: {n.clients}</div>
                    {n.options && <div style={{ fontSize:8, color:"#1e3050" }}>{n.options}</div>}
                  </div>
                ))}
              </>}
            </div>
          )}

          {detailTab === "docker" && docker.available && (
            <div>
              <div style={{ marginBottom:12, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div className="section-title" style={{ marginBottom:0 }}>CONTAINERS</div>
                <span style={{ fontSize:8, color:"#334a6a" }}>Docker {docker.version}</span>
              </div>
              {(docker.containers ?? []).map((c, i) => (
                <div key={i} className="container-row">
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:5 }}>
                    <div className="state-dot" style={{ background: c.state === "running" ? "#4ade80" : "#ff2d78", boxShadow: c.state === "running" ? "0 0 6px #4ade80" : "none" }} />
                    <span style={{ fontSize:10, color:"#c8d8e8", flex:1 }}>{c.name}</span>
                  </div>
                  <div style={{ fontSize:8, color:"#334a6a", marginBottom:5 }}>{c.image}</div>
                  {c.ports?.filter(p => p.host_port).map((p, j) => (
                    <span key={j} className="port-badge">{p.host_port}:{p.container_port}/{p.proto}</span>
                  ))}
                  {c.networks?.map((net, j) => (
                    <span key={j} style={{ display:"inline-block", margin:"2px 3px 0 0", fontSize:7, padding:"1px 5px", border:"1px solid #4ade8020", color:"#4ade8040" }}>{net}</span>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ width:"100vw", height:"100vh", background:"#03030e", fontFamily:"'Azeret Mono','Courier New',monospace", display:"flex", flexDirection:"column", overflow:"hidden", color:"#e2e8f0" }}>
      <style>{CSS}</style>

      {/* ═══ HEADER ════════════════════════════════════════════════════════════ */}
      <div style={{ height:56, flexShrink:0, borderBottom:"1px solid #00f7ff12", display:"flex", alignItems:"center", padding:"0 20px", gap:20, background:"linear-gradient(180deg,#0a0a22 0%,#03030e 100%)" }}>

        <div>
          <div style={{ fontFamily:"'Orbitron',monospace", fontWeight:900, fontSize:16, color:"#00f7ff", letterSpacing:7, lineHeight:1, textShadow:"0 0 24px #00f7ff55" }}>
            NET<span style={{ color:"#f97316", textShadow:"0 0 24px #f9731655" }}>MAP</span>
          </div>
          <div style={{ fontSize:6.5, color:"#0d1a2d", letterSpacing:4, marginTop:2 }}>INFRA TOPOLOGY EXPLORER</div>
        </div>

        <div style={{ width:1, height:28, background:"#00f7ff12" }} />

        {[
          ["AGENTS",    stats.agents     ?? "—"],
          ["VMs/LXCs",  stats.vms        ?? "—"],
          ["CONTAINERS",stats.containers ?? "—"],
        ].map(([k, v]) => (
          <div key={k} style={{ display:"flex", flexDirection:"column", gap:2 }}>
            <div style={{ fontSize:6.5, color:"#1e3050", letterSpacing:3 }}>{k}</div>
            <div className="stat-val" style={{ color:"#00f7ff" }}>{v}</div>
          </div>
        ))}

        <div style={{ flex:1 }} />

        {useMock && (
          <div style={{ fontSize:7.5, color:"#f97316", letterSpacing:2, padding:"4px 10px", border:"1px solid #f9731640", background:"#f9731608" }}>
            MOCK DATA
          </div>
        )}

        {/* WS status */}
        {!useMock && (
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            <div style={{ width:6, height:6, borderRadius:"50%", background: wsStatus === "connected" ? "#4ade80" : "#334a6a", boxShadow: wsStatus === "connected" ? "0 0 8px #4ade80" : "none" }} className={wsStatus !== "connected" ? "blink" : ""} />
            <span style={{ fontSize:7.5, color:"#1e3050", letterSpacing:2 }}>{wsStatus.toUpperCase()}</span>
          </div>
        )}

        <button
          className="scan-btn"
          style={{ color:"#00f7ff", borderColor:"#00f7ff" }}
          onClick={loadTopology}
          disabled={loading}
        >
          {loading ? "◈  LOADING..." : "↺  REFRESH"}
        </button>
      </div>

      {/* ═══ BODY ════════════════════════════════════════════════════════════= */}
      <div style={{ flex:1, display:"flex", overflow:"hidden" }}>

        {/* ── Canvas ─────────────────────────────────────────────────────────── */}
        <div style={{ flex:1, position:"relative", overflow:"hidden" }}>
          <div className="scanline" />
          <div className="crt" />

          <svg ref={svgRef} style={{ width:"100%", height:"100%", display:"block" }} />

          {/* Legend */}
          <div style={{ position:"absolute", bottom:16, left:16, background:"#06061acc", border:"1px solid #00f7ff10", padding:"12px 14px", backdropFilter:"blur(10px)", zIndex:10 }}>
            <div className="section-title" style={{ marginBottom:10 }}>NODE TYPES</div>
            {Object.entries(NC).map(([type, c]) => (
              <div key={type} className="legend-row">
                <div style={{ width:7, height:7, borderRadius:"50%", background:c.color, boxShadow:`0 0 6px ${c.color}`, flexShrink:0 }} />
                <span style={{ fontSize:8.5, color:"#2d3f55" }}>{type.toUpperCase()}</span>
              </div>
            ))}
            <div style={{ marginTop:10, paddingTop:10, borderTop:"1px solid #00f7ff0a" }}>
              <div className="legend-row" style={{ marginBottom:5 }}>
                <div style={{ width:16, height:0, borderTop:"1.5px solid #f97316", opacity:0.5 }} />
                <span style={{ fontSize:7, color:"#1e3050" }}>HYPERVISOR → VM</span>
              </div>
              <div className="legend-row" style={{ marginBottom:5 }}>
                <div style={{ width:16, height:0, borderTop:"1.5px dashed #a78bfa", opacity:0.5 }} />
                <span style={{ fontSize:7, color:"#1e3050" }}>VM → AGENT</span>
              </div>
              <div className="legend-row">
                <div style={{ width:16, height:0, borderTop:"1px solid #38bdf8", opacity:0.4 }} />
                <span style={{ fontSize:7, color:"#1e3050" }}>AGENT → CONTAINER</span>
              </div>
            </div>
            <div style={{ marginTop:8, paddingTop:8, borderTop:"1px solid #00f7ff08", fontSize:7, color:"#1e3050", lineHeight:2 }}>
              SCROLL ↕ ZOOM · DRAG ✥ MOVE<br/>CLICK ◎ INSPECT
            </div>
          </div>
        </div>

        {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
        <div style={{ width:300, borderLeft:"1px solid #00f7ff10", display:"flex", flexDirection:"column", background:"#04041280", backdropFilter:"blur(8px)", flexShrink:0 }}>
          <div style={{ flex:1, overflowY:"auto" }}>
            {renderDetail()}
          </div>
        </div>
      </div>
    </div>
  );
}
