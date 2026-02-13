# UniFi SSH Presence (MQTT)

Home Assistant add-on that polls UniFi AP devices over SSH and publishes `device_tracker` entities via MQTT discovery.

## presence_confidence

`presence_confidence` is an attribute published in extended mode.  
It does not control `home/not_home` state. State logic remains based on MAC detection and `away_after_misses`.

Default confidence scoring is tuned to make floor differences more visible (for typical UniFi/Atheros RSSI values):
- stronger RSSI contributes much more
- rate and idle are included as secondary signals
- optional 5 GHz bonus and SSID penalty

### How to tune

Edit add-on options under `confidence`:
- `rssi_thresholds` + `rssi_scores`
- `idle_thresholds` + `idle_scores`
- `rate_thresholds` + `rate_scores`
- `band5_bonus`
- `ssid_penalty_patterns` + `ssid_penalty`
- `clamp_min` / `clamp_max`

Confidence scoring is active only when:
- `extended_mode: true`
- `confidence.enabled: true`
