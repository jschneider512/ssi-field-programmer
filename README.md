# SSI Field Programmer

A browser-based programmer for SSI MPG pulse initializers. No install —
open the page in Chrome or Edge, connect, program, verify.

Built for field techs and contractors reprogramming MPGs on site.

## Requirements

- **Chrome or Edge** (desktop, or Android Chrome 121+). Web Serial is
  not available in Firefox/Safari.
- USB cable to the MPG (on Android: a USB-C OTG adapter/cable).
- The MPG enumerates as "MCP2221" (Microchip USB bridge).

## Use

1. Open this page. Tap **CONNECT MPG** and pick the MCP2221 device in
   the browser's device list.
2. The page reads the device firmware, current parameters, and (on
   fw 3.x devices) the EUI-64 / install code.
3. Adjust parameters, tap **PROGRAM DEVICE**. Every value is written
   and then **verified by reading the device back** — the page shows
   PASS only if the device confirms every value.
4. On PASS, scan the QR with any phone camera for a human-readable
   record of the programmed values, or copy it as text.

## Demo mode

Tap **demo mode** at the bottom to try the full flow against a built-in
simulated device — no hardware needed.

## Run log

Every attempt (pass and fail) is kept in the browser's local storage
(last 500 runs). Download CSV from the run-log card for records.
Clearing browser data clears the log.

## Notes

- The MPG must be an MPG-family device (MCP2221 bridge, USB VID 04D8
  PID 00DD). PCL/CIR devices are not supported.
- Connect requires a user tap (browser security). The permission is
  remembered per device.
- Works offline after first load.
