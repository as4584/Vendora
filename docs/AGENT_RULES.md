# Vendora — Agent Rules

## 🎯 Purpose

This document defines the behavioral rules that all AI agents must follow when working on Vendora. These rules are **non-negotiable** and exist to protect system stability, revenue integrity, and documentation accuracy.

---

## 🧱 1. Layer Boundary Rules

Vendora has 3 architectural layers. Agents must respect boundaries:

| Layer | Examples | Rules |
|-------|----------|-------|
| **Core Engine** | Auth, Inventory, Payments, Invoices, Profit Calc, Subscriptions, State Machines | ≥ 90% test coverage. No redesign without version migration. Changes require Risk Register update. |
| **Modules** | Barcode, Trust, Seller Pages, Smart Pricing, Insights, QR Labels, CSV Export | May fail without breaking core. Must use defined APIs. Must not introduce circular dependencies. Isolated from payment engine. |
| **Experimental** | Flagged as experimental. May be rewritten. | Must not affect revenue-critical flows. Cannot alter state machine definitions. Must be behind feature flags if touching core. |

---

## 📝 2. Documentation Update Rules

Every feature must:

- Update `ARCHITECTURE.md` if schema changes
- Update `STATE_MACHINES.md` if transitions change
- Update `RISK_REGISTER.md` if exposure changes
- Update `FEATURE_REGISTRY.md` if status changes
- Update `SYSTEM_EVOLUTION_PROTOCOL.md` if expansion logic changes

**Docs are not optional. No silent additions.**

---

## 🔐 3. Core Protection Rules

Revenue-critical systems are sacred:

- Stripe webhooks
- Subscription enforcement
- Profit calculation
- Invoice state machine

Any modification to these requires:

- Full regression test pass
- Integration test pass
- Golden Frame validation
- Manual preview validation

---

## 🧪 4. Feature Addition Protocol

Before adding any feature, agent must evaluate:

1. Which layer does this belong to?
2. Does it modify schema?
3. Does it introduce new state transitions?
4. Does it affect payment logic?
5. Does it increase compliance risk?

If YES to any → update the corresponding canonical docs.

---

## 🚦 5. Anti-Overbuilding Safeguard

Before building any feature, agent must answer:

- **A)** Essential for core loop?
- **B)** Enhancing revenue?
- **C)** Enhancing trust?
- **D)** Purely aesthetic?

If **D** → Defer.

---

## 🛠 6. Refactor Rules

Agents may refactor only when:

- Tests exist
- Golden Frames pass
- Performance improvement is measurable

**Never refactor blindly.**

---

## 📊 7. Feature Registry Rules

Agents must:

- Never modify core engine features without updating `FEATURE_REGISTRY.md`
- Never mark a feature stable without tests
- Never change risk level silently
- Always update coverage percentage
- Always document dependency changes

---

## ⛔ 8. Agents Are NOT Allowed To

- Add complexity without user value
- Pre-optimize scaling prematurely
- Introduce microservices early
- Add marketplace dependency
- Propose UI changes without user request
- Write code that bypasses tier enforcement
- Store sensitive financial data (cards, bank credentials)
- Skip documentation updates

---

## ✅ 9. Agents ARE Allowed To

- Refactor inefficient queries
- Improve performance
- Reduce API latency
- Improve code clarity
- Increase test coverage
- Improve UX clarity

---

## 🧠 Final Principle

Stability compounds. Chaos compounds faster.

Every agent action must increase Vendora's reliability, not its complexity.
