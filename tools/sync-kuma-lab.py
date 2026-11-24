#!/usr/bin/env python3
"""
Syncs cybersecurity classroom workstations and core portals into Uptime Kuma.
Generates SQL inserts and applies them to the live Uptime Kuma SQLite database.
"""

import subprocess
import os

sql_statements = []

def esc(val):
    if val is None:
        return "NULL"
    if isinstance(val, bool):
        return "1" if val else "0"
    if isinstance(val, (int, float)):
        return str(val)
    clean = str(val).replace("'", "''")
    return f"'{clean}'"

# 1. Status Page
sql_statements.append("""
DELETE FROM monitor_group;
DELETE FROM "group";
DELETE FROM monitor;

INSERT OR REPLACE INTO status_page (id, slug, title, description, icon, theme, published, search_engine_index, show_tags, show_powered_by, auto_refresh_interval)
VALUES (1, 'default', 'DuckPond Cybersecurity Lab', 'Real-time telemetry for Classroom Portals, Student Workstations (CV01 - CV28, TITAN, TEST-PC), and Lab Infrastructure.', '/icon.svg', 'dark', 1, 0, 0, 0, 60);

INSERT OR REPLACE INTO setting (key, value, type) VALUES ('entryPage', '"statusPage-default"', 'general');
INSERT OR REPLACE INTO setting (key, value, type) VALUES ('primaryBaseURL', '"http://status.class.net"', 'general');
""")

# 2. Groups and Monitors
groups_data = [
    {
        "id": 1,
        "name": "Core Classroom Portals",
        "weight": 1,
        "monitors": [
            {"name": "Class Lab Hub", "type": "http", "url": "http://class.net", "interval": 60},
            {"name": "CTFd Platform", "type": "http", "url": "http://duckling.ctf.com", "interval": 60},
            {"name": "Duckling AI Tutor", "type": "http", "url": "https://duckling.ai", "interval": 60, "ignore_tls": True},
            {"name": "PCCSK12 NETLAB+", "type": "http", "url": "https://netlab.pccsk12.com", "interval": 60, "ignore_tls": True},
            {"name": "Exam Portal", "type": "http", "url": "https://exam.duckling.local", "interval": 60, "ignore_tls": True, "accepted_statuscodes_json": '["200-299","401"]'},
        ]
    },
    {
        "id": 2,
        "name": "Teacher & Proctor Stations",
        "weight": 2,
        "monitors": [
            {"name": "CV00 (Mr. Obsniuk - Teacher PC)", "type": "ping", "hostname": "192.168.10.70", "interval": 60},
            {"name": "PEARSONADMIN (Proctor PC)", "type": "ping", "hostname": "192.168.10.131", "interval": 60},
            {"name": "CTE10-0135 (Teacher Laptop)", "type": "ping", "hostname": "192.168.10.136", "interval": 60},
        ]
    },
    {
        "id": 3,
        "name": "Student Workstations",
        "weight": 3,
        "monitors": [
            {"name": f"CV{i:02d}", "type": "ping", "hostname": f"192.168.10.{100 + i}", "interval": 60}
            for i in range(1, 29)
        ] + [
            {"name": "TITAN Workstation", "type": "ping", "hostname": "192.168.10.31", "interval": 60},
            {"name": "TEST-PC", "type": "ping", "hostname": "192.168.10.140", "interval": 60},
        ]
    },
    {
        "id": 4,
        "name": "UniFi Network Infrastructure",
        "weight": 4,
        "monitors": [
            {"name": "UniFi Security Gateway (USG)", "type": "ping", "hostname": "192.168.10.1", "interval": 60},
            {"name": "UniFi Switch - Core (LSwitch)", "type": "ping", "hostname": "192.168.10.32", "interval": 60},
            {"name": "UniFi Switch - Access (SSwitch)", "type": "ping", "hostname": "192.168.10.21", "interval": 60},
            {"name": "UniFi Access Point (UAP)", "type": "ping", "hostname": "192.168.10.43", "interval": 60},
        ]
    },
    {
        "id": 5,
        "name": "Lab Infrastructure & Servers",
        "weight": 5,
        "monitors": [
            {"name": "MamaDuck (Domain Controller / DNS)", "type": "ping", "hostname": "192.168.10.5", "interval": 60},
            {"name": "Atlas (Proxmox R620)", "type": "ping", "hostname": "192.168.10.10", "interval": 60},
            {"name": "scrawnyboi", "type": "ping", "hostname": "192.168.10.67", "interval": 60},
            {"name": "nucboi", "type": "ping", "hostname": "192.168.10.68", "interval": 60},
            {"name": "beefyboi", "type": "ping", "hostname": "192.168.10.69", "interval": 60},
            {"name": "Netboot.xyz (iPXE Master)", "type": "ping", "hostname": "192.168.10.6", "interval": 60},
            {"name": "NAS5439CA (Storage 1)", "type": "ping", "hostname": "192.168.10.82", "interval": 60},
            {"name": "NAS5170AD (Storage 2)", "type": "ping", "hostname": "192.168.10.83", "interval": 60},
        ]
    },
    {
        "id": 6,
        "name": "Printers & 3D Fabrication",
        "weight": 6,
        "monitors": [
            {"name": "cheeseboi (HP Network Printer)", "type": "ping", "hostname": "192.168.10.57", "interval": 60},
            {"name": "Bambu Lab 3D Printer", "type": "ping", "hostname": "192.168.10.137", "interval": 60},
        ]
    }
]

monitor_id = 1
for grp in groups_data:
    g_id = grp["id"]
    g_name = esc(grp["name"])
    g_weight = grp["weight"]
    sql_statements.append(f"""
INSERT OR REPLACE INTO "group" (id, name, public, active, weight, status_page_id)
VALUES ({g_id}, {g_name}, 1, 1, {g_weight}, 1);
""")
    for m in grp["monitors"]:
        m_name = esc(m["name"])
        m_type = esc(m["type"])
        m_url = esc(m.get("url"))
        m_host = esc(m.get("hostname"))
        m_int = m.get("interval", 60)
        m_tls = 1 if m.get("ignore_tls") else 0
        m_codes = esc(m.get("accepted_statuscodes_json", '["200-299"]'))

        sql_statements.append(f"""
INSERT OR REPLACE INTO monitor (id, name, active, user_id, interval, url, type, weight, hostname, maxretries, ignore_tls, accepted_statuscodes_json, ping_count, ping_numeric, ping_per_request_timeout)
VALUES ({monitor_id}, {m_name}, 1, 1, {m_int}, {m_url}, {m_type}, 2000, {m_host}, 1, {m_tls}, {m_codes}, 1, 1, 2);

INSERT OR REPLACE INTO monitor_group (id, monitor_id, group_id, weight)
VALUES ({monitor_id}, {monitor_id}, {g_id}, 1000);
""")
        monitor_id += 1

if __name__ == "__main__":
    sql_payload = "\n".join(sql_statements)
    cmd = [
        "kubectl", "--kubeconfig", ".kube/k3s-minecraft.yaml", "exec", "-i",
        "deploy/uptime-kuma", "--", "sqlite3", "/app/data/kuma.db"
    ]
    proc = subprocess.run(cmd, input=sql_payload, text=True, capture_output=True)
    if proc.returncode == 0:
        print(f"Successfully synced {monitor_id - 1} monitors to Uptime Kuma.")
    else:
        print("Error syncing to Uptime Kuma:", proc.stderr)
