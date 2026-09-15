# What remains private

This repository is the engineering core of a system that runs for a real operator. Everything below was removed before publication. Nothing was invented to replace it: where a real name, contact or source had to go, it was replaced by a clearly fictional stand-in of the same shape, so the code and its tests still exercise the same paths.

**Deployment infrastructure.** Deploy scripts, container compose files, reverse-proxy configuration, systemd service and timer units, backup and restore-verification scripts, host addresses and environment values. `.env.example` ships with every secret blank. The generic two-stage `Dockerfile` is kept because it documents how the app is built and run, not where.

**Client identity and economics.** The operator's business name, speciality, address and postcode, contact details, menu and price list, and the commercial detail of their live booking. The product prose refers to "the operator's speciality" rather than naming a dish, and the fixture menu, booking, organizer and city are fictional.

**The live operator database.** No dump, snapshot or extract of the production database is present. The committed sample report is generated from the repository's own fixture snapshot with a pinned `--now`; its counts are fixture counts.

**The messaging-gateway integration.** The signed internal routes are in the code (they are the interesting part: method/path/timestamp/nonce/body-digest binding, per-message idempotency, a secret independent of browser sessions), but the gateway service itself, its credentials, its consent and template handling, and its delivery transport are not part of this repository.

**The full curated source registry.** The private deployment carries a curated registry of dozens of municipal, tourism, organizer, directory and procurement sources — which is the accumulated research, not the engineering. This repository keeps ten representative entries: the six whose extractors the replay harness actually exercises, and four public municipal or tourism census sources. Every other row is a placeholder marked "configured per deployment". The extraction code is complete; only the curated list of real sites is withheld.

**Real contact rows.** Every organizer, municipal and partner email address and telephone number in the fixtures has been replaced with an `@example-*.de` address and a `+49 30 0000000`-pattern number. Real German city names and generic event names ("Street Food Festival &lt;City&gt;") are kept, because they carry no one's identity.

**Credentials.** No API key, password hash, session secret, gateway secret or database URL appears anywhere in this repository or in its commit history.

---

If you are reviewing this as engineering proof and something here reads as a gap rather than a redaction, ask — the reasoning behind any of these boundaries can be explained without crossing them.
