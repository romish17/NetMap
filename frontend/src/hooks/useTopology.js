import { useState, useCallback, useEffect } from "react";
import { api } from "../lib/api.js";

const MOCK = {
  nodes: [
    { id: "proxmox/pve", label: "PVE-HOME", type: "proxmox", ip: "192.168.1.200", stale: false,
      detail: { proxmox: { cpu: 0.08, maxmem: 34359738368, mem: 18000000000, uptime: 864000, node: "pve" } } },
    { id: "proxmox/pve/100", label: "netmap-srv", type: "vm", vmid: 100, parent: "proxmox/pve", ip: "192.168.1.10", status: "running", stale: false, detail: { vm: { name: "netmap-srv", vmid: 100, status: "running", cpu: 0.02, maxmem: 2147483648, mem: 512000000 } } },
    { id: "proxmox/pve/101", label: "traefik", type: "vm", vmid: 101, parent: "proxmox/pve", ip: "192.168.1.11", status: "running", stale: false, detail: { vm: {} } },
    { id: "proxmox/pve/200", label: "pihole-lxc", type: "lxc", vmid: 200, parent: "proxmox/pve", ip: "192.168.1.53", status: "running", stale: false, detail: { vm: {} } },
    { id: "netmap-srv", label: "netmap-srv", type: "agent", ip: "192.168.1.10", os: "Debian 12", stale: false, last_seen: Date.now() - 5000,
      detail: { system: { os: "Debian 12", cpu_cores: 2, ram_total_mb: 2048, ram_used_mb: 520, uptime_secs: 86400, kernel: "6.1.0-18-amd64" }, interfaces: [{ name: "eth0", ip: "192.168.1.10", mac: "52:54:00:ab:01:10", cidr: "/24" }], open_ports: [{ port: 3000, proto: "tcp", process: "node" }, { port: 22, proto: "tcp", process: "sshd" }], shares: { smb: [], nfs: [] },
        docker: { available: true, version: "24.0.7", containers: [
          { id: "a1b2c3", name: "netmap-server", image: "netmap-server:latest", state: "running", status: "Up 3h", ports: [{ host_port: 3000, container_port: 3000, proto: "tcp" }], networks: ["netmap_net"] },
        ]} } },
    { id: "vps-ovh-01", label: "VPS-OVH-01", type: "agent", ip: "51.68.102.77", os: "Ubuntu 22.04", stale: false, last_seen: Date.now() - 8000,
      detail: { system: { os: "Ubuntu 22.04.6 LTS", cpu_cores: 4, ram_total_mb: 4096, ram_used_mb: 1200, uptime_secs: 2592000, kernel: "5.15.0-101-generic" }, interfaces: [{ name: "ens3", ip: "51.68.102.77", mac: "fa:16:3e:ab:cd:ef", cidr: "/32" }], open_ports: [{ port: 22, proto: "tcp", process: "sshd" }, { port: 80, proto: "tcp", process: "nginx" }, { port: 443, proto: "tcp", process: "nginx" }], shares: { smb: [], nfs: [] },
        docker: { available: true, version: "25.0.3", containers: [
          { id: "ng1nx2", name: "nginx", image: "nginx:1.25", state: "running", status: "Up 30d", ports: [{ host_port: 80, container_port: 80, proto: "tcp" }], networks: ["web"] },
          { id: "wg1rd2", name: "wireguard", image: "linuxserver/wireguard", state: "running", status: "Up 30d", ports: [{ host_port: 51820, container_port: 51820, proto: "udp" }], networks: ["host"] },
        ]} } },
    { id: "scanned::192.168.1.50", label: "NAS-DS923+", type: "nas", ip: "192.168.1.50", hasAgent: false, stale: false,
      detail: { open_ports: [{ port: 80, proto: "tcp" }, { port: 443, proto: "tcp" }, { port: 5000, proto: "tcp" }], scanned: { mac: "00:11:32:ab:cd:ef", vendor: "nas", os: "Linux", deviceType: "nas" } } },
    { id: "docker::netmap-srv::a1b2c3", label: "netmap-server", type: "container", image: "netmap-server:latest", state: "running", parent: "netmap-srv", detail: { container: { id: "a1b2c3", name: "netmap-server", image: "netmap-server:latest", state: "running", ports: [{ host_port: 3000, container_port: 3000, proto: "tcp" }], networks: ["netmap_net"] } } },
    { id: "docker::vps-ovh-01::ng1nx2", label: "nginx", type: "container", image: "nginx:1.25", state: "running", parent: "vps-ovh-01", detail: { container: {} } },
    { id: "docker::vps-ovh-01::wg1rd2", label: "wireguard", type: "container", image: "linuxserver/wireguard", state: "running", parent: "vps-ovh-01", detail: { container: {} } },
  ],
  edges: [
    { source: "proxmox/pve", target: "proxmox/pve/100", type: "hypervisor_vm" },
    { source: "proxmox/pve", target: "proxmox/pve/101", type: "hypervisor_vm" },
    { source: "proxmox/pve", target: "proxmox/pve/200", type: "hypervisor_vm" },
    { source: "proxmox/pve/100", target: "netmap-srv", type: "vm_agent" },
    { source: "netmap-srv", target: "docker::netmap-srv::a1b2c3", type: "vm_container" },
    { source: "vps-ovh-01", target: "docker::vps-ovh-01::ng1nx2", type: "vm_container" },
    { source: "vps-ovh-01", target: "docker::vps-ovh-01::wg1rd2", type: "vm_container" },
  ],
};

export function useTopology() {
  const [topology, setTopology] = useState(null);
  const [stats, setStats]       = useState({ agents: 0, vms: 0, containers: 0, scanned: 0 });
  const [loading, setLoading]   = useState(false);
  const [useMock, setUseMock]   = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [topo, st] = await Promise.all([
        api.get("/api/topology"),
        api.get("/api/stats"),
      ]);
      setTopology(topo);
      setStats(st);
      setUseMock(false);
    } catch (err) {
      if (err.message === "unauthenticated") throw err;
      // API unreachable in dev — use mock
      setTopology(MOCK);
      setUseMock(true);
      setStats({
        agents:     MOCK.nodes.filter(n => n.type === "agent").length,
        vms:        MOCK.nodes.filter(n => n.type === "vm" || n.type === "lxc").length,
        containers: MOCK.nodes.filter(n => n.type === "container").length,
        scanned:    MOCK.nodes.filter(n => n.hasAgent === false).length,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { topology, stats, loading, useMock, refresh: load };
}
