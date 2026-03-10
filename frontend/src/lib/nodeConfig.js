export const NC = {
  proxmox:   { color: "#f97316", symbol: "PX", r: 30 },
  vm:        { color: "#a855f7", symbol: "VM", r: 22 },
  lxc:       { color: "#8b5cf6", symbol: "LX", r: 20 },
  agent:     { color: "#00f7ff", symbol: "AG", r: 22 },
  container: { color: "#38bdf8", symbol: "DK", r: 15 },
  nas:       { color: "#fbbf24", symbol: "NS", r: 22 },
  scanned:   { color: "#10b981", symbol: "?",  r: 18 },
  iot:       { color: "#f59e0b", symbol: "IO", r: 16 },
  router:    { color: "#ef4444", symbol: "RT", r: 26 },
  switch:    { color: "#ef4444", symbol: "SW", r: 22 },
  proxmox_host: { color: "#f97316", symbol: "PX", r: 30 },
  linux_generic: { color: "#10b981", symbol: "LX", r: 18 },
  monitoring:    { color: "#4ade80", symbol: "MN", r: 18 },
  windows:       { color: "#60a5fa", symbol: "WN", r: 18 },
  firewall:      { color: "#f87171", symbol: "FW", r: 22 },
  rpi:           { color: "#c084fc", symbol: "RP", r: 18 },
  network:       { color: "#fb923c", symbol: "NW", r: 20 },
  workstation:   { color: "#94a3b8", symbol: "WS", r: 18 },
};

export const EDGE_COLORS = {
  hypervisor_vm: "#f97316",
  vm_agent:      "#a78bfa",
  vm_container:  "#38bdf8",
};

export function getNodeConfig(type) {
  return NC[type] ?? { color: "#94a3b8", symbol: "?", r: 18 };
}
