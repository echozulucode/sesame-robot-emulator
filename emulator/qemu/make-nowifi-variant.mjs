#!/usr/bin/env node
/**
 * Q1 - build the "Wi-Fi elided" QEMU test variant.
 *
 * THIS IS NOT STOCK FIRMWARE and must never be described as such.
 *
 * Espressif's QEMU has no ESP32 Wi-Fi MAC/PHY model at all, so unmodified
 * Sesame firmware hard-stops inside `esp_phy_enable` at bootOrder step 7 and
 * can never reach steps 16-19 (PWM allocate / servo attach / setFace), which
 * are the steps this project actually cares about. This script produces a
 * deliberately modified source so the question "does the SERVO path execute
 * under QEMU, and does real telemetry come out of it?" can be answered at all.
 *
 * It makes exactly three kinds of change, all inside setup()/loop(), and all
 * done by commenting lines OUT IN PLACE so that line numbering is preserved
 * and the boot ladder still lines up with hardware-map.json:
 *
 *   1. the Wi-Fi bring-up, SoftAP, mDNS and DNS-server lines are commented out
 *   2. the two loop() calls that service DNS/HTTP are commented out
 *   3. one line is INJECTED on an existing blank line at the end of setup(),
 *      setting currentCommand = "wave" - because with no HTTP server there is
 *      no way to ask the robot to move, and a robot that never moves emits no
 *      servo telemetry.
 *
 * Input is the already-patched scratch sketch (V1 board patch + R6 telemetry
 * patch). Nothing under firmware/ is touched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKETCH = path.join(REPO, 'tools', 'arduino-data', 'scratch', 'qemu-nowifi',
  'sesame-firmware-main', 'sesame-firmware-main.ino');

const src = fs.readFileSync(SKETCH, 'utf8');
const eol = src.includes('\r\n') ? '\r\n' : '\n';
const lines = src.split(/\r?\n/);

// Anchored by TEXT, not by number, so this script fails loudly instead of
// silently commenting out the wrong thing if the patches ever move.
const commentOut = [
  'WiFi.persistent(false);',
  'if (ENABLE_NETWORK_MODE && String(NETWORK_SSID).length() > 0) {',
  'if (!connectToWifi(NETWORK_SSID, NETWORK_PASS)) {',
  'Serial.println("Failed to connect to network. Running in AP-only mode.");',
  'WiFi.mode(WIFI_AP); // Fall back to AP-only',
  '}',                                   // closes the inner if  - resolved positionally below
  '} else {',
  'WiFi.mode(WIFI_AP);',
  'Serial.println("Network mode disabled. Running in AP-only mode.");',
  '}',                                   // closes the else
  'WiFi.softAP(AP_SSID, AP_PASS);',
  'IPAddress myIP = WiFi.softAPIP();',
  'Serial.print("AP Created. IP: ");',
  'Serial.println(myIP);',
  'if (networkConnected) {',
  'announceNetwork(NETWORK_SSID);',
  '} else {',
  'setApOnlyInfoText();',
  'startMdns();',
  '}',
  'dnsServer.start(DNS_PORT, "*", myIP);',
  // server.on(...) route registration (steps 13/14) is pure bookkeeping and is
  // LEFT IN - it runs fine. server.begin() is not: it opens an lwIP socket, and
  // lwIP's tcpip thread is started by WiFi.mode(), which we just removed. It
  // asserts in xQueueSemaphoreTake on a null mutex. That is a consequence of
  // this elision, not a QEMU limitation.
  'server.begin();',
  'dnsServer.processNextRequest();',
  'server.handleClient();',
  'updateWifiSetup();',
];

// Walk forward from `void setup() {` matching each target in order. Sequential
// matching is what lets the bare `}` entries resolve unambiguously.
let i = lines.findIndex((l) => l.trim() === 'void setup() {');
if (i < 0) throw new Error('could not find setup() in the scratch sketch');
const changed = [];
for (const target of commentOut) {
  let j = i;
  while (j < lines.length && lines[j].trim() !== target) j++;
  if (j >= lines.length) throw new Error(`anchor not found after line ${i + 1}: ${target}`);
  lines[j] = lines[j].replace(/^(\s*)/, '$1// [Q1-NOWIFI] ');
  changed.push(j + 1);
  i = j + 1;
}

// Inject the movement trigger on the existing blank line just before the final
// Serial.println of setup(), so the line count does not move.
const endIdx = lines.findIndex((l) => l.trim() === 'Serial.println(F("HTTP server & Captive Portal started."));');
if (endIdx < 1) throw new Error('could not find the end-of-setup banner');
if (lines[endIdx - 1].trim() !== '') throw new Error(`expected a blank line at ${endIdx}, got: ${lines[endIdx - 1]}`);
lines[endIdx - 1] = '  currentCommand = "wave"; // [Q1-NOWIFI] no HTTP server exists, so drive one movement directly';

fs.writeFileSync(SKETCH, lines.join(eol));
console.log(`[q1] commented out ${changed.length} lines: ${changed.join(', ')}`);
console.log(`[q1] injected movement trigger at line ${endIdx}`);
console.log(`[q1] total lines ${lines.length} (unchanged count: ${lines.length === src.split(/\r?\n/).length})`);
