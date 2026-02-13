#!/usr/bin/env python3
import json
import re
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

import paho.mqtt.client as mqtt


@dataclass
class AP:
    name: str
    host: str


@dataclass
class Device:
    mac: str
    name: str
    allow_randomized: bool = False


@dataclass
class SSHConfig:
    username: str
    password: str
    port: int
    connect_timeout_sec: int
    cmd_timeout_sec: int
    known_hosts_strict: bool


@dataclass
class MQTTConfig:
    host: str
    port: int
    username: str
    password: str
    discovery_prefix: str
    base_topic: str
    client_id: str


OPTIONS_PATH = "/data/options.json"
LEARN_SEEN_PATH = "/data/seen_devices.json"

MAC_RE = re.compile(r"^([0-9a-f]{2}:){5}[0-9a-f]{2}$", re.IGNORECASE)
IPV4_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")


def load_options() -> dict:
    with open(OPTIONS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def sh(cmd: List[str], timeout: int) -> Tuple[int, str, str]:
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        out, err = p.communicate(timeout=timeout)
        return p.returncode, out, err
    except subprocess.TimeoutExpired:
        p.kill()
        out, err = p.communicate()
        return 124, out, err


def ssh_run(host: str, sshc: SSHConfig, remote_cmd: str) -> Tuple[int, str, str]:
    strict = sshc.known_hosts_strict
    ssh_opts = [
        "-o", f"ConnectTimeout={sshc.connect_timeout_sec}",
        "-o", "BatchMode=no",
        "-o", "LogLevel=ERROR",
    ]
    if not strict:
        ssh_opts += ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null"]

    cmd = [
        "sshpass", "-p", sshc.password,
        "ssh",
        *ssh_opts,
        "-p", str(sshc.port),
        f"{sshc.username}@{host}",
        remote_cmd
    ]
    return sh(cmd, timeout=sshc.cmd_timeout_sec)


def get_wifi_ifaces(host: str, sshc: SSHConfig) -> List[str]:
    remote = r"ls -1 /sys/class/net 2>/dev/null | grep -E '^wifi[0-9]+ap[0-9]+$' | sort"
    rc, out, err = ssh_run(host, sshc, remote)
    if rc != 0:
        raise RuntimeError(f"iface detect failed on {host} rc={rc} err={err.strip()}")
    return [line.strip() for line in out.splitlines() if line.strip()]


def parse_wlanconfig_list(output: str) -> Dict[str, Dict]:
    lines = [ln.strip() for ln in output.splitlines() if ln.strip()]
    if not lines:
        return {}

    header_idx = None
    for i, ln in enumerate(lines):
        if ln.upper().startswith("ADDR"):
            header_idx = i
            break
    if header_idx is None or header_idx == len(lines) - 1:
        return {}

    header = re.split(r"\s+", lines[header_idx])
    col_index = {name.upper(): idx for idx, name in enumerate(header)}

    results: Dict[str, Dict] = {}
    for ln in lines[header_idx + 1:]:
        parts = re.split(r"\s+", ln)
        if not parts:
            continue
        mac = parts[0].lower()
        if not MAC_RE.match(mac):
            continue

        rec: Dict = {"mac": mac}

        if "RSSI" in col_index and col_index["RSSI"] < len(parts):
            try:
                rec["rssi"] = int(parts[col_index["RSSI"]])
            except ValueError:
                pass

        results[mac] = rec

    return results


def parse_ip_neigh(output: str) -> Dict[str, str]:
    mac_to_ip: Dict[str, str] = {}
    for ln in output.splitlines():
        ln = ln.strip()
        if not ln:
            continue
        parts = ln.split()
        if len(parts) < 5:
            continue
        ip = parts[0]
        if not IPV4_RE.match(ip):
            continue
        try:
            i = parts.index("lladdr")
            mac = parts[i + 1].lower()
        except (ValueError, IndexError):
            continue
        if MAC_RE.match(mac):
            mac_to_ip[mac] = ip
    return mac_to_ip


def band_from_iface(iface: str) -> str:
    if iface.startswith("wifi0"):
        return "2.4"
    if iface.startswith("wifi1"):
        return "5"
    return "?"


def is_randomized_mac(mac: str) -> bool:
    # locally administered bit = 1 in first octet (0x02)
    try:
        first_octet = int(mac.split(":")[0], 16)
    except Exception:
        return False
    return bool(first_octet & 0b00000010)


def is_multicast_or_broadcast(mac: str) -> bool:
    if mac.lower() == "ff:ff:ff:ff:ff:ff":
        return True
    try:
        first_octet = int(mac.split(":")[0], 16)
    except Exception:
        return False
    return bool(first_octet & 0b00000001)


def slugify(s: str) -> str:
    s = s.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = re.sub(r"_+", "_", s)
    s = s.strip("_")
    return s or "device"


def object_id_for_device(dev: Device) -> str:
    return f"unifi_{slugify(dev.name)}_{dev.mac.replace(':','')}"


def discovery_topic(prefix: str, node_id: str, object_id: str) -> str:
    return f"{prefix}/device_tracker/{node_id}/{object_id}/config"


def state_topic(base: str, mac: str) -> str:
    return f"{base}/{mac}/state"


def attr_topic(base: str, mac: str) -> str:
    return f"{base}/{mac}/attributes"


def publish_discovery(client: mqtt.Client, cfg: MQTTConfig, dev: Device) -> None:
    obj_id = object_id_for_device(dev)
    topic = discovery_topic(cfg.discovery_prefix, "unifi_ssh_presence", obj_id)
    payload = {
        "name": dev.name,
        "unique_id": obj_id,
        "source_type": "router",
        "state_topic": state_topic(cfg.base_topic, dev.mac),
        "payload_home": "home",
        "payload_not_home": "not_home",
        "json_attributes_topic": attr_topic(cfg.base_topic, dev.mac),
        "device": {
            "identifiers": [obj_id],
            "manufacturer": "Custom",
            "model": "UniFi SSH Presence",
            "name": dev.name,
        },
    }
    client.publish(topic, json.dumps(payload, ensure_ascii=False), qos=1, retain=True)


def publish_state(client: mqtt.Client, cfg: MQTTConfig, mac: str, is_home: bool) -> None:
    client.publish(
        state_topic(cfg.base_topic, mac),
        "home" if is_home else "not_home",
        qos=1,
        retain=True,
    )


def publish_attrs(client: mqtt.Client, cfg: MQTTConfig, mac: str, attrs: dict) -> None:
    client.publish(
        attr_topic(cfg.base_topic, mac),
        json.dumps(attrs, ensure_ascii=False),
        qos=1,
        retain=True,
    )


def best_record(a: dict, b: dict) -> dict:
    ar = a.get("rssi")
    br = b.get("rssi")
    if ar is None and br is None:
        return a
    if ar is None:
        return b
    if br is None:
        return a
    return a if ar >= br else b


def now_ts_iso() -> Tuple[int, str]:
    ts = int(time.time())
    iso = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
    return ts, iso


def load_seen_devices() -> Dict[str, dict]:
    try:
        with open(LEARN_SEEN_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            seen = data.get("seen", [])
            out: Dict[str, dict] = {}
            for item in seen:
                mac = (item.get("mac") or "").lower().strip()
                if MAC_RE.match(mac):
                    out[mac] = item
            return out
    except Exception:
        return {}


def save_seen_devices(seen_map: Dict[str, dict]) -> None:
    items = list(seen_map.values())
    items.sort(key=lambda x: int(x.get("last_seen_ts") or 0), reverse=True)
    payload = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "seen": items,
    }

    tmp = LEARN_SEEN_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    import os
    os.replace(tmp, LEARN_SEEN_PATH)


def trim_seen(seen_map: Dict[str, dict], max_entries: int) -> Dict[str, dict]:
    if max_entries <= 0:
        return {}
    items = list(seen_map.values())
    items.sort(key=lambda x: int(x.get("last_seen_ts") or 0), reverse=True)
    kept = items[:max_entries]
    return {item["mac"].lower(): item for item in kept if "mac" in item}


def mqtt_connect_wait(cfg: MQTTConfig, timeout_sec: int = 10) -> mqtt.Client:
    connected = {"rc": None}

    def on_connect(client, userdata, flags, rc):
        connected["rc"] = rc

    client = mqtt.Client(client_id=cfg.client_id, clean_session=True)
    client.on_connect = on_connect

    if cfg.username:
        client.username_pw_set(cfg.username, cfg.password or None)

    client.connect_async(cfg.host, cfg.port, keepalive=60)
    client.loop_start()

    start = time.time()
    while time.time() - start < timeout_sec:
        if connected["rc"] is not None:
            break
        time.sleep(0.1)

    if connected["rc"] is None:
        client.loop_stop()
        raise RuntimeError(f"MQTT connect timeout to {cfg.host}:{cfg.port}")

    if connected["rc"] != 0:
        client.loop_stop()
        raise RuntimeError(f"MQTT connection refused rc={connected['rc']} (check username/password/ACL)")

    return client


def main() -> None:
    opts = load_options()

    mqtt_cfg = MQTTConfig(
        host=opts["mqtt"]["host"],
        port=int(opts["mqtt"]["port"]),
        username=opts["mqtt"].get("username") or "",
        password=opts["mqtt"].get("password") or "",
        discovery_prefix=opts["mqtt"]["discovery_prefix"],
        base_topic=opts["mqtt"]["base_topic"],
        client_id=opts["mqtt"]["client_id"],
    )

    ssh_cfg = SSHConfig(
        username=opts["ssh"]["username"],
        password=opts["ssh"]["password"],
        port=int(opts["ssh"]["port"]),
        connect_timeout_sec=int(opts["ssh"]["connect_timeout_sec"]),
        cmd_timeout_sec=int(opts["ssh"]["cmd_timeout_sec"]),
        known_hosts_strict=bool(opts["ssh"]["known_hosts_strict"]),
    )

    aps_raw = opts.get("aps", [])
    aps: List[AP] = []
    for a in aps_raw:
        name = (a.get("name") or "").strip()
        host = (a.get("host") or "").strip()
        if not (name and host):
            continue
        aps.append(AP(name=name, host=host))

    learn_mode = bool(opts.get("learn_mode", False))
    learn_max_entries = int(opts.get("learn_max_entries", 50))

    devices_raw = opts.get("devices", [])
    devices: List[Device] = []
    for d in devices_raw:
        mac = (d.get("mac") or "").strip().lower()
        name = (d.get("name") or "").strip()
        if not (mac and name and MAC_RE.match(mac)):
            continue
        devices.append(Device(mac=mac, name=name, allow_randomized=bool(d.get("allow_randomized", False))))

    if not aps:
        raise SystemExit("No APs configured. Add aps: [{name,host}] in add-on options.")

    if not devices and not learn_mode:
        raise SystemExit("No devices configured. Add devices: [{mac,name}] in add-on options or enable learn_mode.")

    if not devices and learn_mode:
        print("[unifi-ssh-presence] no tracked devices configured; running in learn-only mode")

    device_by_mac: Dict[str, Device] = {d.mac: d for d in devices}

    poll_interval = int(opts["poll_interval_sec"])
    away_after = int(opts["away_after_misses"])

    if not ssh_cfg.password:
        raise SystemExit("SSH password is empty. Set it in add-on options.")

    print("[unifi-ssh-presence] connecting mqtt...")
    mqc = mqtt_connect_wait(mqtt_cfg, timeout_sec=10)
    print("[unifi-ssh-presence] mqtt connected")

    # MQTT discovery
    for dev in devices:
        publish_discovery(mqc, mqtt_cfg, dev)

    iface_cache: Dict[str, List[str]] = {}
    iface_refresh_every_cycles = 40  # ~1 hour if poll is 90s
    cycle = 0

    # tracked state caches (for change-only log)
    prev_home: Dict[str, Optional[bool]] = {d.mac: None for d in devices}
    prev_ap: Dict[str, Optional[str]] = {d.mac: None for d in devices}
    prev_ip: Dict[str, Optional[str]] = {d.mac: None for d in devices}

    misses: Dict[str, int] = {d.mac: 0 for d in devices}
    last_seen: Dict[str, int] = {d.mac: 0 for d in devices}
    last_seen_iso: Dict[str, str] = {d.mac: "" for d in devices}

    # learn storage (persistent)
    seen_unknown: Dict[str, dict] = load_seen_devices() if learn_mode else {}
    learn_dirty = False

    while True:
        cycle += 1

        seen_global_tracked: Dict[str, dict] = {}
        seen_global_unknown: Dict[str, dict] = {}

        for ap in aps:
            try:
                if ap.host not in iface_cache or (cycle % iface_refresh_every_cycles == 1):
                    iface_cache[ap.host] = get_wifi_ifaces(ap.host, ssh_cfg)
                ifaces = iface_cache[ap.host]

                # Single SSH per AP per cycle; mark sections for parsing
                parts: List[str] = []
                parts.append("echo '###NEIGH_BEGIN'")
                parts.append("ip neigh show 2>/dev/null || true")
                parts.append("echo '###NEIGH_END'")
                for iface in ifaces:
                    parts.append(f"echo '###IFACE {iface} BEGIN'")
                    parts.append(f"wlanconfig {iface} list 2>/dev/null || true")
                    parts.append(f"echo '###IFACE {iface} END'")
                remote = "; ".join(parts)

                rc, out, err = ssh_run(ap.host, ssh_cfg, remote)
                if rc != 0:
                    print(f"[warn] ssh failed ap={ap.name} host={ap.host} rc={rc} err={err.strip()}")
                    continue

                neigh_buf: List[str] = []
                iface_txt: Dict[str, str] = {}
                cur_iface: Optional[str] = None
                buf: List[str] = []
                in_neigh = False

                for ln in out.splitlines():
                    if ln.startswith("###NEIGH_BEGIN"):
                        in_neigh = True
                        continue
                    if ln.startswith("###NEIGH_END"):
                        in_neigh = False
                        continue

                    m = re.match(r"^###IFACE\s+(\S+)\s+BEGIN$", ln)
                    if m:
                        cur_iface = m.group(1)
                        buf = []
                        continue

                    m = re.match(r"^###IFACE\s+(\S+)\s+END$", ln)
                    if m:
                        if cur_iface:
                            iface_txt[cur_iface] = "\n".join(buf)
                        cur_iface = None
                        buf = []
                        continue

                    if in_neigh:
                        neigh_buf.append(ln)
                    elif cur_iface:
                        buf.append(ln)

                mac_to_ip = parse_ip_neigh("\n".join(neigh_buf))

                seen_ap_tracked: Dict[str, dict] = {}
                seen_ap_unknown: Dict[str, dict] = {}

                for iface, txt in iface_txt.items():
                    macs = parse_wlanconfig_list(txt)
                    for mac, rec in macs.items():
                        mac = mac.lower()

                        if is_multicast_or_broadcast(mac):
                            continue

                        is_randomized = is_randomized_mac(mac)

                        rec2 = dict(rec)
                        rec2["ap_name"] = ap.name
                        rec2["ap_host"] = ap.host
                        rec2["iface"] = iface
                        rec2["band"] = band_from_iface(iface)
                        if mac in mac_to_ip:
                            rec2["ip"] = mac_to_ip[mac]

                        if mac in device_by_mac:
                            dev = device_by_mac[mac]
                            if is_randomized and not dev.allow_randomized:
                                continue
                            rec2["friendly_name"] = dev.name
                            seen_ap_tracked[mac] = best_record(seen_ap_tracked.get(mac, rec2), rec2)
                        else:
                            if learn_mode:
                                # learn: ignore randomized MACs to avoid noise
                                if is_randomized:
                                    continue
                                seen_ap_unknown[mac] = best_record(seen_ap_unknown.get(mac, rec2), rec2)

                # merge AP -> global
                for mac, rec in seen_ap_tracked.items():
                    seen_global_tracked[mac] = best_record(seen_global_tracked.get(mac, rec), rec)

                if learn_mode:
                    for mac, rec in seen_ap_unknown.items():
                        seen_global_unknown[mac] = best_record(seen_global_unknown.get(mac, rec), rec)

            except Exception as e:
                print(f"[warn] exception on ap={ap.name} host={ap.host}: {e}")

        now_seen_tracked = set(seen_global_tracked.keys())

        # update misses/last_seen
        for dev in devices:
            mac = dev.mac
            if mac in now_seen_tracked:
                misses[mac] = 0
                ts, iso = now_ts_iso()
                last_seen[mac] = ts
                last_seen_iso[mac] = iso
            else:
                misses[mac] += 1

        # tracked publish + change-only logs
        for dev in devices:
            mac = dev.mac
            is_home_now = mac in now_seen_tracked
            became_away_now = (not is_home_now) and (misses.get(mac, 0) >= away_after)

            if is_home_now:
                rec = dict(seen_global_tracked[mac])
                rec["last_seen_ts"] = last_seen.get(mac, 0)
                rec["last_seen_iso"] = last_seen_iso.get(mac, "")
                rec["misses"] = misses.get(mac, 0)

                publish_state(mqc, mqtt_cfg, mac, True)
                publish_attrs(mqc, mqtt_cfg, mac, rec)

                ap_now = rec.get("ap_name")
                ip_now = rec.get("ip")
                rssi_now = rec.get("rssi")

                if prev_home[mac] is not True:
                    print(f"[state] {dev.name}: home (ap={ap_now} rssi={rssi_now} ip={ip_now})")
                elif ap_now != prev_ap[mac]:
                    print(f"[state] {dev.name}: moved ap={ap_now} (was {prev_ap[mac]}) rssi={rssi_now}")
                elif ip_now and ip_now != prev_ip[mac]:
                    print(f"[state] {dev.name}: ip={ip_now} (was {prev_ip[mac]})")

                prev_home[mac] = True
                prev_ap[mac] = ap_now
                prev_ip[mac] = ip_now

            elif became_away_now:
                publish_state(mqc, mqtt_cfg, mac, False)
                publish_attrs(mqc, mqtt_cfg, mac, {
                    "friendly_name": dev.name,
                    "ap_name": None,
                    "ap_host": None,
                    "iface": None,
                    "band": None,
                    "rssi": None,
                    "ip": None,
                    "misses": misses.get(mac, 0),
                    "last_seen_ts": last_seen.get(mac, 0),
                    "last_seen_iso": last_seen_iso.get(mac, ""),
                })

                if prev_home[mac] is not False:
                    print(f"[state] {dev.name}: not_home (misses={misses.get(mac, 0)})")

                prev_home[mac] = False
                prev_ap[mac] = None
                prev_ip[mac] = None

        # learn mode: persist unknown list, log only on change
        if learn_mode and seen_global_unknown:
            for mac, rec in seen_global_unknown.items():
                ts, iso = now_ts_iso()

                prev = seen_unknown.get(mac)
                prev_ip_val = (prev.get("ip") if prev else None)
                new_ip = rec.get("ip")

                is_new = prev is None
                ip_became_known = (not prev_ip_val) and bool(new_ip)

                new_item = {
                    "mac": mac,
                    "ip": new_ip or (prev_ip_val if prev else None),
                    "ap_name": rec.get("ap_name"),
                    "ap_host": rec.get("ap_host"),
                    "iface": rec.get("iface"),
                    "band": rec.get("band"),
                    "rssi": rec.get("rssi"),
                    "last_seen_ts": ts,
                    "last_seen_iso": iso,
                }
                seen_unknown[mac] = new_item

                if is_new:
                    learn_dirty = True
                    print(f"[learn] new device seen: {mac} ip={new_item.get('ip')} ap={new_item.get('ap_name')} rssi={new_item.get('rssi')}")
                elif ip_became_known:
                    learn_dirty = True
                    print(f"[learn] device got IPv4: {mac} ip={new_item.get('ip')} ap={new_item.get('ap_name')} rssi={new_item.get('rssi')}")

            before_len = len(seen_unknown)
            seen_unknown = trim_seen(seen_unknown, learn_max_entries)
            if len(seen_unknown) != before_len:
                learn_dirty = True

            if learn_dirty:
                try:
                    save_seen_devices(seen_unknown)
                except Exception as e:
                    print(f"[warn] failed saving learn file: {e}")
                learn_dirty = False

        time.sleep(poll_interval)


if __name__ == "__main__":
    main()
