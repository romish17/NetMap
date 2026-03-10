package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// ─── Config ────────────────────────────────────────────────────────────────

var (
	serverURL    = envOr("NETMAP_SERVER", "http://netmap-server:3000")
	agentToken   = envOr("NETMAP_TOKEN", "changeme")
	pushInterval = durationEnv("NETMAP_INTERVAL", 30*time.Second)
	agentID      = envOr("NETMAP_AGENT_ID", mustHostname())
	dockerSocket = envOr("DOCKER_SOCKET", "/var/run/docker.sock")
)

// ─── Data model ────────────────────────────────────────────────────────────

type Report struct {
	AgentID    string     `json:"agent_id"`
	Hostname   string     `json:"hostname"`
	ReportedAt time.Time  `json:"reported_at"`
	System     SystemInfo `json:"system"`
	Interfaces []Iface    `json:"interfaces"`
	OpenPorts  []Port     `json:"open_ports"`
	Shares     Shares     `json:"shares"`
	Docker     DockerInfo `json:"docker"`
}

type SystemInfo struct {
	OS         string  `json:"os"`
	Arch       string  `json:"arch"`
	Kernel     string  `json:"kernel"`
	UptimeSecs int64   `json:"uptime_secs"`
	CPUCores   int     `json:"cpu_cores"`
	RAMTotalMB int64   `json:"ram_total_mb"`
	RAMUsedMB  int64   `json:"ram_used_mb"`
	DiskInfos  []Disk  `json:"disks"`
}

type Disk struct {
	Mount      string `json:"mount"`
	TotalGB    int64  `json:"total_gb"`
	UsedGB     int64  `json:"used_gb"`
	Filesystem string `json:"filesystem"`
}

type Iface struct {
	Name string `json:"name"`
	IP   string `json:"ip"`
	MAC  string `json:"mac"`
	CIDR string `json:"cidr"`
}

type Port struct {
	Port    int    `json:"port"`
	Proto   string `json:"proto"`
	Process string `json:"process"`
	State   string `json:"state"`
}

type Shares struct {
	SMB []SMBShare  `json:"smb"`
	NFS []NFSExport `json:"nfs"`
}

type SMBShare struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Comment string `json:"comment"`
}

type NFSExport struct {
	Path    string `json:"path"`
	Clients string `json:"clients"`
	Options string `json:"options"`
}

type DockerInfo struct {
	Available  bool        `json:"available"`
	Version    string      `json:"version"`
	Containers []Container `json:"containers"`
}

type Container struct {
	ID       string            `json:"id"`
	Name     string            `json:"name"`
	Image    string            `json:"image"`
	Status   string            `json:"status"`
	State    string            `json:"state"`
	Ports    []ContainerPort   `json:"ports"`
	Networks []string          `json:"networks"`
	Labels   map[string]string `json:"labels,omitempty"`
	Created  int64             `json:"created"`
}

type ContainerPort struct {
	HostIP    string `json:"host_ip,omitempty"`
	HostPort  int    `json:"host_port"`
	Container int    `json:"container_port"`
	Proto     string `json:"proto"`
}

// ─── Main ──────────────────────────────────────────────────────────────────

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lmsgprefix)
	log.SetPrefix("[netmap-agent] ")

	log.Printf("Starting — agent_id=%s  server=%s  interval=%s",
		agentID, serverURL, pushInterval)

	// First push immediately
	push()

	ticker := time.NewTicker(pushInterval)
	defer ticker.Stop()
	for range ticker.C {
		push()
	}
}

func push() {
	r := collect()
	data, err := json.Marshal(r)
	if err != nil {
		log.Printf("marshal error: %v", err)
		return
	}

	req, err := http.NewRequest("POST", serverURL+"/api/agent/report", bytes.NewReader(data))
	if err != nil {
		log.Printf("request error: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+agentToken)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("push error: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("server returned %d", resp.StatusCode)
		return
	}
	log.Printf("pushed report (%d ports, %d containers)",
		len(r.OpenPorts), len(r.Docker.Containers))
}

// ─── Collect ───────────────────────────────────────────────────────────────

func collect() Report {
	hostname, _ := os.Hostname()
	return Report{
		AgentID:    agentID,
		Hostname:   hostname,
		ReportedAt: time.Now().UTC(),
		System:     collectSystem(),
		Interfaces: collectInterfaces(),
		OpenPorts:  collectPorts(),
		Shares:     collectShares(),
		Docker:     collectDocker(),
	}
}

// ─── System ────────────────────────────────────────────────────────────────

func collectSystem() SystemInfo {
	si := SystemInfo{
		OS:       detectOS(),
		Arch:     runtime.GOARCH,
		Kernel:   readKernel(),
		CPUCores: runtime.NumCPU(),
	}
	si.UptimeSecs = readUptimeSecs()
	si.RAMTotalMB, si.RAMUsedMB = readMemMB()
	si.DiskInfos = readDisks()
	return si
}

func detectOS() string {
	// Try /etc/os-release first
	data, err := os.ReadFile("/etc/os-release")
	if err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "PRETTY_NAME=") {
				return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
			}
		}
	}
	// Fallback: uname
	out, err := exec.Command("uname", "-s", "-r").Output()
	if err != nil {
		return runtime.GOOS
	}
	return strings.TrimSpace(string(out))
}

func readKernel() string {
	out, err := exec.Command("uname", "-r").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func readUptimeSecs() int64 {
	data, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return 0
	}
	f, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0
	}
	return int64(f)
}

func readMemMB() (total, used int64) {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return
	}
	var memTotal, memFree, buffers, cached int64
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		val, _ := strconv.ParseInt(fields[1], 10, 64)
		switch fields[0] {
		case "MemTotal:":
			memTotal = val
		case "MemFree:":
			memFree = val
		case "Buffers:":
			buffers = val
		case "Cached:":
			cached = val
		}
	}
	total = memTotal / 1024
	used = (memTotal - memFree - buffers - cached) / 1024
	return
}

func readDisks() []Disk {
	out, err := exec.Command("df", "-BG", "--output=target,fstype,size,used").Output()
	if err != nil {
		return nil
	}
	var disks []Disk
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	for _, line := range lines[1:] {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		mount := fields[0]
		// Skip pseudo-filesystems
		if strings.HasPrefix(mount, "/proc") || strings.HasPrefix(mount, "/sys") ||
			strings.HasPrefix(mount, "/dev") || mount == "/run" {
			continue
		}
		fs := fields[1]
		total, _ := strconv.ParseInt(strings.TrimSuffix(fields[2], "G"), 10, 64)
		used, _ := strconv.ParseInt(strings.TrimSuffix(fields[3], "G"), 10, 64)
		disks = append(disks, Disk{Mount: mount, Filesystem: fs, TotalGB: total, UsedGB: used})
	}
	return disks
}

// ─── Interfaces ────────────────────────────────────────────────────────────

func collectInterfaces() []Iface {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var result []Iface
	for _, iface := range ifaces {
		// Skip loopback and down
		if iface.Flags&net.FlagLoopback != 0 || iface.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip, cidr string
			switch v := addr.(type) {
			case *net.IPNet:
				if v.IP.To4() == nil {
					continue // skip IPv6 for now
				}
				ip = v.IP.String()
				ones, _ := v.Mask.Size()
				cidr = fmt.Sprintf("/%d", ones)
			}
			if ip == "" {
				continue
			}
			result = append(result, Iface{
				Name: iface.Name,
				IP:   ip,
				MAC:  iface.HardwareAddr.String(),
				CIDR: cidr,
			})
		}
	}
	return result
}

// ─── Ports ─────────────────────────────────────────────────────────────────

func collectPorts() []Port {
	// Use ss for listening ports with process names (requires root or CAP_NET_ADMIN for process names)
	out, err := exec.Command("ss", "-tlnpH").Output()
	if err != nil {
		// Fallback: netstat
		return collectPortsNetstat()
	}
	return parseSSOutput(string(out), "tcp")
}

func parseSSOutput(output, proto string) []Port {
	var ports []Port
	seen := map[int]bool{}
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		// Local address is fields[3], format: *:PORT or ADDR:PORT
		addrPort := fields[3]
		colonIdx := strings.LastIndex(addrPort, ":")
		if colonIdx < 0 {
			continue
		}
		portStr := addrPort[colonIdx+1:]
		port, err := strconv.Atoi(portStr)
		if err != nil || port == 0 || seen[port] {
			continue
		}
		seen[port] = true

		process := ""
		// Process info is typically in last field: users:(("nginx",pid=123,fd=6))
		for _, f := range fields[4:] {
			if strings.HasPrefix(f, "users:") {
				start := strings.Index(f, `"`)
				end := strings.LastIndex(f, `"`)
				if start >= 0 && end > start {
					process = f[start+1 : end]
				}
				break
			}
		}

		ports = append(ports, Port{
			Port:    port,
			Proto:   proto,
			Process: process,
			State:   "LISTEN",
		})
	}
	return ports
}

func collectPortsNetstat() []Port {
	out, err := exec.Command("netstat", "-tlnp").Output()
	if err != nil {
		return nil
	}
	var ports []Port
	seen := map[int]bool{}
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.HasPrefix(line, "tcp") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		addrPort := fields[3]
		colonIdx := strings.LastIndex(addrPort, ":")
		if colonIdx < 0 {
			continue
		}
		port, err := strconv.Atoi(addrPort[colonIdx+1:])
		if err != nil || port == 0 || seen[port] {
			continue
		}
		seen[port] = true
		process := ""
		if len(fields) >= 7 {
			parts := strings.Split(fields[6], "/")
			if len(parts) == 2 {
				process = parts[1]
			}
		}
		ports = append(ports, Port{Port: port, Proto: "tcp", Process: process, State: "LISTEN"})
	}
	return ports
}

// ─── Shares ────────────────────────────────────────────────────────────────

func collectShares() Shares {
	return Shares{
		SMB: parseSMBConf("/etc/samba/smb.conf"),
		NFS: parseNFSExports("/etc/exports"),
	}
}

func parseSMBConf(path string) []SMBShare {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var shares []SMBShare
	var current *SMBShare
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") || line == "" {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			name := line[1 : len(line)-1]
			if name == "global" || name == "homes" || name == "printers" {
				current = nil
				continue
			}
			shares = append(shares, SMBShare{Name: name})
			current = &shares[len(shares)-1]
		} else if current != nil {
			parts := strings.SplitN(line, "=", 2)
			if len(parts) != 2 {
				continue
			}
			key := strings.TrimSpace(parts[0])
			val := strings.TrimSpace(parts[1])
			switch key {
			case "path":
				current.Path = val
			case "comment":
				current.Comment = val
			}
		}
	}
	return shares
}

func parseNFSExports(path string) []NFSExport {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var exports []NFSExport
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 1 {
			continue
		}
		exp := NFSExport{Path: fields[0]}
		if len(fields) >= 2 {
			// Parse client(options) format
			clientOpt := fields[1]
			paren := strings.Index(clientOpt, "(")
			if paren >= 0 {
				exp.Clients = clientOpt[:paren]
				exp.Options = strings.Trim(clientOpt[paren:], "()")
			} else {
				exp.Clients = clientOpt
			}
		}
		exports = append(exports, exp)
	}
	return exports
}

// ─── Docker ────────────────────────────────────────────────────────────────

type dockerTransport struct {
	socket string
}

func (t *dockerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	conn, err := net.Dial("unix", t.socket)
	if err != nil {
		return nil, err
	}
	return (&http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return net.Dial("unix", t.socket)
		},
	}).RoundTrip(req)
	_ = conn
}

func dockerClient(socket string) *http.Client {
	return &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return net.Dial("unix", socket)
			},
		},
	}
}

type dockerVersion struct {
	Version string `json:"Version"`
}

type dockerContainer struct {
	ID    string   `json:"Id"`
	Names []string `json:"Names"`
	Image string   `json:"Image"`
	Status string  `json:"Status"`
	State  string  `json:"State"`
	Created int64  `json:"Created"`
	Ports []struct {
		IP          string `json:"IP"`
		PrivatePort int    `json:"PrivatePort"`
		PublicPort  int    `json:"PublicPort"`
		Type        string `json:"Type"`
	} `json:"Ports"`
	NetworkSettings struct {
		Networks map[string]interface{} `json:"Networks"`
	} `json:"NetworkSettings"`
	Labels map[string]string `json:"Labels"`
}

func collectDocker() DockerInfo {
	if _, err := os.Stat(dockerSocket); err != nil {
		return DockerInfo{Available: false}
	}

	client := dockerClient(dockerSocket)

	// Version
	var version string
	resp, err := client.Get("http://docker/version")
	if err == nil {
		defer resp.Body.Close()
		var v dockerVersion
		if json.NewDecoder(resp.Body).Decode(&v) == nil {
			version = v.Version
		}
	} else {
		return DockerInfo{Available: false}
	}

	// Containers (all)
	resp2, err := client.Get("http://docker/containers/json?all=true")
	if err != nil {
		return DockerInfo{Available: true, Version: version}
	}
	defer resp2.Body.Close()

	var rawContainers []dockerContainer
	if err := json.NewDecoder(resp2.Body).Decode(&rawContainers); err != nil {
		return DockerInfo{Available: true, Version: version}
	}

	var containers []Container
	for _, c := range rawContainers {
		name := c.ID[:12]
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}

		var ports []ContainerPort
		for _, p := range c.Ports {
			if p.PublicPort == 0 {
				continue
			}
			ports = append(ports, ContainerPort{
				HostIP:    p.IP,
				HostPort:  p.PublicPort,
				Container: p.PrivatePort,
				Proto:     p.Type,
			})
		}

		var networks []string
		for net := range c.NetworkSettings.Networks {
			networks = append(networks, net)
		}

		containers = append(containers, Container{
			ID:       c.ID[:12],
			Name:     name,
			Image:    c.Image,
			Status:   c.Status,
			State:    c.State,
			Ports:    ports,
			Networks: networks,
			Labels:   c.Labels,
			Created:  c.Created,
		})
	}

	return DockerInfo{
		Available:  true,
		Version:    version,
		Containers: containers,
	}
}

// ─── Helpers ───────────────────────────────────────────────────────────────

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func durationEnv(key string, def time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return def
	}
	return d
}

func mustHostname() string {
	h, err := os.Hostname()
	if err != nil {
		return "unknown-host"
	}
	return h
}
