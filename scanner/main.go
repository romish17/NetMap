package main

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/gopacket"
	"github.com/google/gopacket/layers"
	"github.com/google/gopacket/pcap"
)

// ─── Config ────────────────────────────────────────────────────────────────

var (
	serverURL     = envOr("NETMAP_SERVER", "http://server:3000")
	agentToken    = envOr("NETMAP_TOKEN", "changeme")
	scanNetworks  = strings.Split(envOr("SCAN_NETWORKS", "192.168.1.0/24"), ",")
	scanInterval  = durationEnv("SCAN_INTERVAL", 300*time.Second)
	nmpArgs       = strings.Fields(envOr("NMAP_ARGS", "-sV --top-ports 50 -O --osscan-limit -T4"))
	maxConcurrent = 10
)

// ─── Data model ────────────────────────────────────────────────────────────

type ScanResult struct {
	ScannedAt time.Time     `json:"scanned_at"`
	Network   string        `json:"network"`
	Hosts     []ScannedHost `json:"hosts"`
}

type ScannedHost struct {
	IP         string `json:"ip"`
	MAC        string `json:"mac"`
	Vendor     string `json:"vendor"`
	Hostname   string `json:"hostname"`
	OS         string `json:"os"`
	DeviceType string `json:"device_type"`
	OpenPorts  []Port `json:"open_ports"`
	HasAgent   bool   `json:"has_agent"`
}

type Port struct {
	Port    int    `json:"port"`
	Proto   string `json:"proto"`
	Service string `json:"service"`
	Version string `json:"version"`
}

// ─── nmap XML structs ─────────────────────────────────────────────────────

type NmapRun struct {
	Hosts []NmapHost `xml:"host"`
}

type NmapHost struct {
	Addresses []NmapAddress   `xml:"address"`
	Hostnames []NmapHostnames `xml:"hostnames"`
	Ports     NmapPorts       `xml:"ports"`
	OS        NmapOS          `xml:"os"`
}

type NmapAddress struct {
	Addr     string `xml:"addr,attr"`
	AddrType string `xml:"addrtype,attr"`
	Vendor   string `xml:"vendor,attr"`
}

type NmapHostnames struct {
	Hostnames []NmapHostname `xml:"hostname"`
}

type NmapHostname struct {
	Name string `xml:"name,attr"`
}

type NmapPorts struct {
	Ports []NmapPort `xml:"port"`
}

type NmapPort struct {
	Protocol string      `xml:"protocol,attr"`
	PortID   int         `xml:"portid,attr"`
	State    NmapState   `xml:"state"`
	Service  NmapService `xml:"service"`
}

type NmapState struct {
	State string `xml:"state,attr"`
}

type NmapService struct {
	Name    string `xml:"name,attr"`
	Product string `xml:"product,attr"`
	Version string `xml:"version,attr"`
}

type NmapOS struct {
	Matches []NmapOSMatch `xml:"osmatch"`
}

type NmapOSMatch struct {
	Name     string `xml:"name,attr"`
	Accuracy int    `xml:"accuracy,attr"`
}

// ─── OUI table (compact - major prefixes only) ───────────────────────────

var ouiTable = map[string]string{
	// VMware/QEMU/VirtualBox (→ vm)
	"00:0c:29": "vm", "00:50:56": "vm", "52:54:00": "vm",
	"08:00:27": "vm", "00:15:5d": "vm",
	// Synology (→ nas)
	"00:11:32": "nas",
	// QNAP (→ nas)
	"24:5e:be": "nas", "00:08:9b": "nas",
	// Ubiquiti (→ network)
	"24:a4:3c": "network", "78:8a:20": "network", "fc:ec:da": "network",
	"80:2a:a8": "network", "b4:fb:e4": "network",
	// TP-Link (→ switch)
	"50:c7:bf": "switch", "ec:08:6b": "switch",
	// Cisco (→ switch)
	"00:1a:a2": "switch", "00:0d:ec": "switch",
	// Raspberry Pi (→ rpi)
	"b8:27:eb": "rpi", "dc:a6:32": "rpi", "e4:5f:01": "rpi",
	// Apple (→ workstation)
	"a4:c3:f0": "workstation", "3c:22:fb": "workstation",
}

func lookupOUI(mac string) string {
	if len(mac) < 8 {
		return ""
	}
	prefix := strings.ToLower(mac[:8])
	if t, ok := ouiTable[prefix]; ok {
		return t
	}
	return ""
}

// ─── Device type heuristics ────────────────────────────────────────────────

func detectDeviceType(host ScannedHost) string {
	portSet := map[int]bool{}
	for _, p := range host.OpenPorts {
		portSet[p.Port] = true
	}

	// 1. Port signatures (highest priority)
	if portSet[8006] {
		return "proxmox"
	}
	if portSet[5000] || portSet[5001] {
		return "nas"
	}
	if portSet[9090] || portSet[9100] {
		return "monitoring"
	}
	if portSet[1883] {
		return "iot"
	}
	if portSet[3389] {
		return "windows"
	}

	// 2. OUI MAC lookup
	if host.MAC != "" {
		if t := lookupOUI(host.MAC); t != "" {
			return t
		}
	}

	// 3. nmap OS string
	osLower := strings.ToLower(host.OS)
	if strings.Contains(osLower, "windows") {
		return "windows"
	}
	if strings.Contains(osLower, "cisco ios") {
		return "switch"
	}
	if strings.Contains(osLower, "pfsense") || strings.Contains(osLower, "freebsd") {
		return "firewall"
	}
	if strings.Contains(osLower, "linux") {
		return "linux_generic"
	}

	// 4. Only SSH → linux
	if portSet[22] && len(host.OpenPorts) == 1 {
		return "linux_generic"
	}

	return "scanned"
}

// ─── ARP sweep ────────────────────────────────────────────────────────────

type arpResult struct {
	IP  string
	MAC string
}

func arpSweep(network string, iface string) ([]arpResult, error) {
	ip, ipNet, err := net.ParseCIDR(network)
	if err != nil {
		return nil, fmt.Errorf("invalid network %s: %w", network, err)
	}
	_ = ip

	// Find interface if not specified
	if iface == "" {
		ifaces, err := net.Interfaces()
		if err != nil {
			return nil, err
		}
		for _, i := range ifaces {
			if i.Flags&net.FlagLoopback != 0 || i.Flags&net.FlagUp == 0 {
				continue
			}
			addrs, _ := i.Addrs()
			for _, addr := range addrs {
				if ipAddr, ok := addr.(*net.IPNet); ok {
					if ipNet.Contains(ipAddr.IP) {
						iface = i.Name
						break
					}
				}
			}
			if iface != "" {
				break
			}
		}
	}
	if iface == "" {
		return nil, fmt.Errorf("no suitable interface found for %s", network)
	}

	handle, err := pcap.OpenLive(iface, 65536, true, 3*time.Second)
	if err != nil {
		return nil, fmt.Errorf("pcap open %s: %w", iface, err)
	}
	defer handle.Close()

	if err := handle.SetBPFFilter("arp"); err != nil {
		return nil, err
	}

	// Get local interface
	localIface, err := net.InterfaceByName(iface)
	if err != nil {
		return nil, err
	}

	// Enumerate IPs in the subnet
	var ips []net.IP
	for cur := cloneIP(ipNet.IP.Mask(ipNet.Mask)); ipNet.Contains(cur); incrementIP(cur) {
		ips = append(ips, cloneIP(cur))
	}
	// Remove network address and broadcast
	if len(ips) > 2 {
		ips = ips[1 : len(ips)-1]
	}

	results := map[string]arpResult{}
	var mu sync.Mutex
	done := make(chan struct{})

	// Capture goroutine
	go func() {
		defer close(done)
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			data, _, err := handle.ReadPacketData()
			if err != nil {
				break
			}
			packet := gopacket.NewPacket(data, layers.LayerTypeEthernet, gopacket.Default)
			arpLayer := packet.Layer(layers.LayerTypeARP)
			if arpLayer == nil {
				continue
			}
			arp, _ := arpLayer.(*layers.ARP)
			if arp.Operation != layers.ARPReply {
				continue
			}
			srcIP := net.IP(arp.SourceProtAddress).String()
			srcMAC := net.HardwareAddr(arp.SourceHwAddress).String()
			mu.Lock()
			results[srcIP] = arpResult{IP: srcIP, MAC: srcMAC}
			mu.Unlock()
		}
	}()

	// Send ARP requests
	for _, targetIP := range ips {
		sendARP(handle, localIface, targetIP)
	}

	<-done

	mu.Lock()
	defer mu.Unlock()
	out := make([]arpResult, 0, len(results))
	for _, r := range results {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].IP < out[j].IP })
	return out, nil
}

func sendARP(handle *pcap.Handle, iface *net.Interface, targetIP net.IP) {
	eth := layers.Ethernet{
		SrcMAC:       iface.HardwareAddr,
		DstMAC:       net.HardwareAddr{0xff, 0xff, 0xff, 0xff, 0xff, 0xff},
		EthernetType: layers.EthernetTypeARP,
	}
	localAddrs, _ := iface.Addrs()
	var localIP net.IP
	for _, addr := range localAddrs {
		if ipNet, ok := addr.(*net.IPNet); ok && ipNet.IP.To4() != nil {
			localIP = ipNet.IP.To4()
			break
		}
	}
	if localIP == nil {
		return
	}
	arp := layers.ARP{
		AddrType:          layers.LinkTypeEthernet,
		Protocol:          layers.EthernetTypeIPv4,
		HwAddressSize:     6,
		ProtAddressSize:   4,
		Operation:         layers.ARPRequest,
		SourceHwAddress:   []byte(iface.HardwareAddr),
		SourceProtAddress: []byte(localIP.To4()),
		DstHwAddress:      []byte{0, 0, 0, 0, 0, 0},
		DstProtAddress:    []byte(targetIP.To4()),
	}
	buf := gopacket.NewSerializeBuffer()
	opts := gopacket.SerializeOptions{FixLengths: true, ComputeChecksums: true}
	if err := gopacket.SerializeLayers(buf, opts, &eth, &arp); err != nil {
		return
	}
	_ = handle.WritePacketData(buf.Bytes())
}

func cloneIP(ip net.IP) net.IP {
	clone := make(net.IP, len(ip))
	copy(clone, ip)
	return clone
}

func incrementIP(ip net.IP) {
	for j := len(ip) - 1; j >= 0; j-- {
		ip[j]++
		if ip[j] > 0 {
			break
		}
	}
}

// ─── nmap scan ────────────────────────────────────────────────────────────

func nmapScan(ip string) ([]Port, string, string, error) {
	args := append([]string{"-oX", "-"}, nmpArgs...)
	args = append(args, ip)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, "nmap", args...).Output()
	if err != nil {
		return nil, "", "", fmt.Errorf("nmap: %w", err)
	}

	var run NmapRun
	if err := xml.Unmarshal(out, &run); err != nil {
		return nil, "", "", err
	}
	if len(run.Hosts) == 0 {
		return nil, "", "", nil
	}
	h := run.Hosts[0]

	var ports []Port
	for _, p := range h.Ports.Ports {
		if p.State.State != "open" {
			continue
		}
		ports = append(ports, Port{
			Port:    p.PortID,
			Proto:   p.Protocol,
			Service: p.Service.Name,
			Version: strings.TrimSpace(p.Service.Product + " " + p.Service.Version),
		})
	}

	osName := ""
	for _, m := range h.OS.Matches {
		if m.Accuracy >= 70 {
			osName = m.Name
			break
		}
	}

	hostname := ""
	for _, hns := range h.Hostnames {
		for _, hn := range hns.Hostnames {
			hostname = hn.Name
			break
		}
	}

	return ports, osName, hostname, nil
}

// ─── Reverse DNS ─────────────────────────────────────────────────────────

func reverseDNS(ip string) string {
	names, err := net.LookupAddr(ip)
	if err != nil || len(names) == 0 {
		return ""
	}
	return strings.TrimSuffix(names[0], ".")
}

// ─── Push to server ───────────────────────────────────────────────────────

func pushReport(result ScanResult) error {
	data, err := json.Marshal(result)
	if err != nil {
		return err
	}
	req, err := http.NewRequest("POST", serverURL+"/api/scanner/report", bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+agentToken)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		buf := make([]byte, 512)
		n, _ := resp.Body.Read(buf)
		return fmt.Errorf("server returned %d: %s", resp.StatusCode, strings.TrimSpace(string(buf[:n])))
	}
	return nil
}

func pushProgress(done, total int, currentIP, network string) {
	body := map[string]interface{}{
		"done":       done,
		"total":      total,
		"current_ip": currentIP,
		"network":    network,
	}
	data, _ := json.Marshal(body)
	req, err := http.NewRequest("POST", serverURL+"/api/scanner/progress", bytes.NewReader(data))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+agentToken)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[scanner] pushProgress: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		buf := make([]byte, 256)
		n, _ := resp.Body.Read(buf)
		log.Printf("[scanner] pushProgress: server returned %d: %s", resp.StatusCode, strings.TrimSpace(string(buf[:n])))
	}
}

// ─── Full scan cycle ─────────────────────────────────────────────────────

func scanNetwork(network string) {
	network = strings.TrimSpace(network)
	if network == "" {
		return
	}

	log.Printf("[scanner] ARP sweep: %s", network)
	arpResults, err := arpSweep(network, "")
	if err != nil {
		log.Printf("[scanner] ARP sweep error: %v", err)
		return
	}
	total := len(arpResults)
	log.Printf("[scanner] Found %d hosts via ARP on %s", total, network)

	if total == 0 {
		// Rien à scanner — envoyer un rapport vide pour signaler la fin
		pushReport(ScanResult{ScannedAt: time.Now().UTC(), Network: network, Hosts: []ScannedHost{}})
		return
	}

	// Signaler au serveur le total réel trouvé par l'ARP sweep
	pushProgress(0, total, "", network)

	sem := make(chan struct{}, maxConcurrent)
	var mu sync.Mutex
	var hosts []ScannedHost
	var wg sync.WaitGroup
	var completedCount int64 // compteur atomique d'hôtes traités

	for _, ar := range arpResults {
		wg.Add(1)
		ar := ar
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			host := ScannedHost{
				IP:  ar.IP,
				MAC: ar.MAC,
			}

			// Vendor from OUI
			host.Vendor = lookupOUI(ar.MAC)

			// Reverse DNS
			host.Hostname = reverseDNS(ar.IP)

			// nmap
			ports, osName, nmapHostname, err := nmapScan(ar.IP)
			if err != nil {
				log.Printf("[scanner] nmap error %s: %v", ar.IP, err)
			} else {
				host.OpenPorts = ports
				host.OS = osName
				if host.Hostname == "" && nmapHostname != "" {
					host.Hostname = nmapHostname
				}
			}

			host.DeviceType = detectDeviceType(host)

			mu.Lock()
			hosts = append(hosts, host)
			mu.Unlock()

			// Mise à jour de progression APRÈS traitement (compteur réel)
			done := int(atomic.AddInt64(&completedCount, 1))
			pushProgress(done, total, ar.IP, network)
		}()
	}
	wg.Wait()

	result := ScanResult{
		ScannedAt: time.Now().UTC(),
		Network:   network,
		Hosts:     hosts,
	}

	if err := pushReport(result); err != nil {
		log.Printf("[scanner] push error: %v", err)
	} else {
		log.Printf("[scanner] pushed %d hosts for %s", len(hosts), network)
	}
}

// ─── HTTP trigger server ─────────────────────────────────────────────────

func startTriggerServer() {
	mux := http.NewServeMux()

	// POST /trigger — déclenche un scan immédiat
	mux.HandleFunc("/trigger", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		log.Printf("HTTP trigger received — launching immediate scan")
		for _, network := range scanNetworks {
			go scanNetwork(network)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	})

	// GET /health
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	})

	triggerPort := envOr("SCANNER_TRIGGER_PORT", "9080")
	log.Printf("HTTP trigger server listening on :%s", triggerPort)
	if err := http.ListenAndServe(":"+triggerPort, mux); err != nil {
		log.Printf("HTTP trigger server error: %v", err)
	}
}

// ─── Main ────────────────────────────────────────────────────────────────

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lmsgprefix)
	log.SetPrefix("[netmap-scanner] ")
	log.Printf("Starting — networks=%v  interval=%s", scanNetworks, scanInterval)
	if agentToken == "changeme" {
		log.Printf("WARNING: NETMAP_TOKEN is not set (using default 'changeme') — reports will be rejected with 401!")
	}

	// Serveur HTTP pour les triggers manuels
	go startTriggerServer()

	// Premier scan immédiat au démarrage
	for _, network := range scanNetworks {
		go scanNetwork(network)
	}

	ticker := time.NewTicker(scanInterval)
	defer ticker.Stop()
	for range ticker.C {
		for _, network := range scanNetworks {
			go scanNetwork(network)
		}
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────

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
