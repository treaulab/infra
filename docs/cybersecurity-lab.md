# Cybersecurity Lab & CompTIA Training Portal

This document outlines the architecture, network configuration, and service directory for the classroom Cybersecurity Lab, designed to support hands-on training for **CompTIA certifications** (Security+, Network+, CySA+, PenTest+, and A+).

---

## 1. Classroom Architecture & Topology

The lab operates on an isolated private local area network (`192.168.10.0/24`), anchored by an Active Directory Domain Controller (`MamaDuck`) and serviced by dedicated containerized platforms.

```text
                                  +---------------------------------------+
                                  |   MamaDuck (192.168.10.5)             |
                                  |   Windows Server 2022                 |
                                  |   - Active Directory (duckling.local) |
                                  |   - Authoritative DNS Server          |
                                  |   - DHCP & Kerberos                   |
                                  +---------------------------------------+
                                                     |
         +-------------------------------------------+-------------------------------------------+
         |                                           |                                           |
+-----------------------------------+   +-----------------------------------+   +-----------------------------------+
| Minecraft Node (192.168.10.76)    |   | AI & Knowledge Node (.68)         |   | Student Lab Workstations          |
| - K3s Standalone Cluster          |   | (nucboi)                          |   | - CV03-CV27 (.62 - .149)          |
| - MetalLB VIP: 192.168.10.77      |   | - duckling.ai (Open WebUI)        |   | - CTE10-0134 / CTE10-0135         |
| - Traefik Ingress Controller      |   | - affine.duckling.ai (Wiki/Docs)  |   | - PearsonAdmin (.131)             |
| - Class Lab Hub (Homepage)        |   | - auth.duckling.ai (Identity/SSO) |   | - QuackTester / labvm (.134)      |
| - Docker: CTFd (Port 80)          |   +-----------------------------------+   +-----------------------------------+
+-----------------------------------+                                                             |
                                                                                +-----------------------------------+
                                                                                | Testing Delivery Server           |
                                                                                | exam.duckling.local (192.168.10.70)|
                                                                                | Microsoft-IIS 10.0 Secure Exams   |
                                                                                +-----------------------------------+
```

---

## 2. Core Service Directory & Access Endpoints

Students and instructors access all classroom resources through the central **Class Lab Hub** (Homepage) or direct intranet links:

| Service / Platform | Access URL | Underpinning Infrastructure | CompTIA Curriculum Alignment |
| :--- | :--- | :--- | :--- |
| **Class Lab Hub** | `http://class.net`<br>`http://class/`<br>`http://class.lan` | MetalLB VIP `192.168.10.77` on Minecraft K3s | Central navigation and daily operational hub |
| **Uptime Kuma** | `http://status.class.net/status/default`<br>`http://status/status/default` | K3s on `minecraft` (`192.168.10.77:3001`) | **Security+ / CySA+**: Service availability, SLAs, outage alerting, and health monitoring |
| **CTFd Platform** | `http://duckling.ctf.com` | Docker on `192.168.10.76:80` | **Security+ / PenTest+**: Hands-on capture-the-flag challenges, flags, crypto, and web security |
| **PCCSK12 NETLAB+** | `https://netlab.pccsk12.com` | Remote training pod at `10.7.13.3` | **Network+ / Security+**: Cisco routing, firewall configuration, Linux sandbox pods |
| **Exam Delivery Portal** | `https://exam.duckling.local` | Windows Server IIS at `192.168.10.70` | **Certification Delivery**: Official proctored exam testing and assessment engine |
| **Duckling AI Tutor** | `https://duckling.ai` | Containerized LLM on `192.168.10.68` | **Study & Review**: Real-time AI explanation of networking concepts, acronyms, and attack vectors |
| **AFFiNE Knowledge Base** | `https://affine.duckling.ai` | Collaborative workspace on `192.168.10.68` | Course syllabi, write-ups, vulnerability notes, and lab guides |

---

## 3. DNS Configuration (`MamaDuck` @ `192.168.10.5`)

Local DNS is centrally managed in Microsoft DNS Server on `MamaDuck`. It uses split-brain resolution to keep all class operations internal without public leakage:

### Active Forward Lookup Zones

1. **`class.net` (Direct Public TLD Zone)**
   - `@`, `www`, and `*` $\rightarrow$ `192.168.10.77`
   - Primary domain for browser navigation (`class.net`, `status.class.net`, `kuma.class.net`).

2. **`class` & `status` (Top-Level Single-Label Zones)**
   - `@` and `*` $\rightarrow$ `192.168.10.77`
   - Enables instant browser navigation via `class/` and `status/`.

3. **`lan`**
   - `class`, `status`, and `*` (Wildcard) $\rightarrow$ `192.168.10.77`

4. **`duckling.local` (Active Directory Domain Zone)**
   - `class`, `status` $\rightarrow$ `192.168.10.77` (Resolves for AD-joined clients with default search suffixes)
   - `exam` $\rightarrow$ `192.168.10.70` (Exam delivery server)
   - `mamaduck` $\rightarrow$ `192.168.10.5` (DC/DNS)
   - `minecraft` $\rightarrow$ `192.168.10.76` (Host)
   - Workstations: `CV03`–`CV27`, `CTE10-0134`, `CTE10-0135`, `PearsonAdmin` (`.131`), `QuackTester` (`.134`)

5. **`ctf.com` (Override Zone)**
   - `duckling.ctf.com` $\rightarrow$ `192.168.10.76`

5. **`duckling.ai` (Internal Override Zone)**
   - `@`, `affine`, `auth`, `www` $\rightarrow$ `192.168.10.68`

6. **`netlab.pccsk12.com`**
   - `@` $\rightarrow$ `10.7.13.3`

---

## 4. Kubernetes Manifests & GitOps Workflow

All portal declarations live in Git under `kubernetes/minecraft/manifests/homepage.yaml`:

- **Ingress Controller**: Traefik listening on VIP `192.168.10.77` (managed by MetalLB Layer 2 pool `192.168.10.77 - 192.168.10.81`).
- **Ingress Hosts**: Accepts `class`, `class.lan`, `duckling.lan`, `*.lan`, and IP direct hits.
- **Environment**: `HOMEPAGE_ALLOWED_HOSTS: "*"` to allow multi-domain intranet access without Next.js HTTP 400 rejection.

### Common Operator Commands (via Justfile)

```bash
# Check status of Minecraft cluster nodes and pods
just k-mc get nodes -o wide
just k-mc get pods -A

# Apply manifest updates
just k-apply minecraft

# Restart Homepage deployment after config changes
just k-mc rollout restart deployment/homepage

# Test HTTP response for class/
curl -I -H "Host: class" http://192.168.10.77/
```

---

## 5. Security & Isolation Controls

1. **Air-Gapped / Split-DNS Boundary**: The `class/` portal and internal nodes (`.local`, `.lan`) are never announced or reachable outside the local subnet.
2. **Cluster Separation**: The classroom apps run on the dedicated `minecraft` node cluster (`192.168.10.76-81`), keeping production infrastructure (`mercury`..`pluto` on `.200-.220`) strictly isolated.
3. **Dedicated Administrative Host**: Proctoring and exam administration workstations (`PearsonAdmin`) operate on static IP assignments to maintain testing compliance.
