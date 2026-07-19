# QDEF Record Type Examples

These are informative examples — illustrative Record Type definitions showing
how applications register and use their own types under QDEF. They are not
part of the normative spec; see [QDEF-SPEC.md](QDEF-SPEC.md) for the
format definition.

## Type `100`: Wi-Fi Provisioning

```
[ 100, {
  0: "My Coffee Shop",  // CRITICAL: SSID
  2: "guest123",        // CRITICAL: Password
  4: 2,                 // CRITICAL: Auth Type (0=Open, 1=WEP, 2=WPA2/3)
  1: true                // OPTIONAL: Hidden Network Flag
} ]
```

## Type `106`: Universal Transit / Event Ticket

```
[ 106, {
  0: h'A7F90B...',       // CRITICAL: Ticket Hash/Token
  2: 1735689600,         // CRITICAL: Expiry Epoch Timestamp
  3: "General Admit",    // OPTIONAL: UI Display Text
  1: "Gate A"            // OPTIONAL: Wayfinding Hint
} ]
```
