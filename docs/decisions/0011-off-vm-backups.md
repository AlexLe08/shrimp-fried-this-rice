# 0011: Encrypted copies of `bot.db` go to Oracle Object Storage, through a write-only URL

Status: Proposed · 2026-11-23

## Context

`bot.db` is one file on the VM's disk. It holds every server's reminders,
and soon bridges' webhook tokens and keys and players' links. Snapshots
on the VM (#59, owner-only since #60) cover a bad migration, deleted rows
and a [0003](0003-pre-release-schema-resets.md) reset, but not losing the
VM or its boot volume: they sit on the same disk. The roadmap's Next up
item 1 asks for an encrypted copy off the VM, decided first, as it
probably needs a tool or a runtime dependency.

Constraints: free tiers only, nothing that needs a payment method
(CLAUDE.md); the owner isn't publishing the bot widely, so the file is
small (kilobytes to a few megabytes) and one copy a day is a handful of
requests a month. Since the file will hold secrets, the copy must be
encrypted before it leaves the VM, and whatever the VM holds to write
copies shouldn't let someone who takes over the VM read, change or
delete the earlier ones.

Where, checked on 2026-11-23 against each provider's docs (Sources):

| Option | Free amount | Payment method | Notes |
|---|---|---|---|
| **Oracle Object Storage** (Always Free) | 20 GB across tiers, 50,000 API requests a month | None (the tenancy the VM is in) | A bucket-level pre-authenticated request (PAR) with "Permit object writes" (`AnyObjectWrite`) is a URL that uploads with a plain HTTPS `PUT`: no signing, no SDK. It can't list ("denied by default", allowed only for read PARs) or delete. Its expiry is required "but has no limits". Same Oracle account as the VM. |
| Backblaze B2 | 10 GB | Not confirmed (the pricing page lists "Credit card or invoice" for billing; the sign-up flow wasn't read) | S3-compatible; Object Lock at no extra cost. Independent of Oracle. Needs signed requests, so an S3 client (a dependency) or hand-written SigV4. |
| Cloudflare R2 | 10 GB-month | Probably: getting started says to "complete the checkout flow to add an R2 subscription" (not stated outright) | Ruled out unless the owner confirms no card is asked for. |
| A private GitHub repository | Recommended under 1 GB | None | GitHub's docs: "Git is not designed to serve as a backup tool", nor for "large SQL files". Every copy stays in history for good. The deploy key would need push access, which can also rewrite or delete. Set aside. |
| Copied off by hand (`scp` from the owner's machine) | — | None | Only as fresh as the last time someone remembers. Set aside. |

How it's encrypted, also checked on 2026-11-23:

| Option | What it adds | Notes |
|---|---|---|
| **age format, to a public key, with the `age-encryption` npm package** | A runtime dependency: `age-encryption` 0.3.1 (BSD-3-Clause, by age's author), which depends on `@noble/ciphers`, `@noble/curves`, `@noble/hashes`, `@noble/post-quantum` and `@scure/base` | The VM holds only the recipient (`age1…`, a public key); the identity that decrypts lives off the VM with the owner. The output is authenticated (an HMAC over the header; ChaCha20-Poly1305 chunks, so a cut-off or altered file fails to decrypt). Comes in with `npm ci` like the bot's other dependencies, and tests can encrypt and decrypt in Vitest. A copy is decrypted with the `age` CLI on any machine. |
| The `age` CLI on the VM, run by the bot | A tool installed by hand (`apt install age`, 1.1.1 in Ubuntu 24.04's `universe`) | Same format and key handling, no npm dependency. Outside the deploy, like `cloudflared` ([0008](0008-dashboard-hostname-and-https.md)): a new VM needs it installed, and CI's tests would have to mock it or install it too. |
| Hand-written with `node:crypto` | Nothing | Node 24 has everything needed (X25519 with `diffieHellman`, `hkdfSync`, AES-GCM and ChaCha20-Poly1305; tried locally on v24.21.0), but the file format and its key handling would be the bot's own, unreviewed crypto, and a restore would need the bot's code. Node's docs warn GCM decryption accepts short tags unless `authTagLength` is set. Set aside. |
| `gpg` | A tool (whether Ubuntu's cloud image has it wasn't confirmed) | Public-key mode works, but its keyrings and options are much larger than this needs. Set aside. |
| A symmetric key in `.env` (any of the above) | — | The VM would hold the key that decrypts every copy. Set aside for a public key. |

## Decision

Once a day, after the daily snapshot, the bot encrypts that snapshot to
the owner's age public key with the `age-encryption` package and uploads
it with `fetch` to a bucket in the tenancy's Oracle Object Storage,
through a write-only PAR. The PAR's URL and the age recipient are set in
`.env`; the age identity that decrypts is kept by the owner, off the VM.
The bucket has a time-bound retention rule, left unlocked, so a copy
can't be overwritten or deleted for its first 30 days, and a lifecycle
policy deletes copies older than 60 days.

**Why:** TODO(Alex)

## Consequences

- Covers losing the VM, its boot volume, or every snapshot on it, up to
  the last daily copy. Doesn't cover losing the Oracle account itself
  (an account Oracle closes, or a region-wide loss of Object Storage):
  the copies are in the same tenancy. If that becomes a worry, a second
  copy to B2 would be a new record, once someone has checked in a
  browser that B2's free 10 GB asks for no card.
- Adds a runtime dependency, `age-encryption`, and its five
  `@noble`/`@scure` packages, in the implementing PR. It's at 0.x.
  Its format is age v1, so if it's ever dropped, copies still decrypt
  with the `age` CLI and the bot could switch to the CLI.
- Someone who takes over the VM gets the PAR's URL and the public key.
  They can't list or delete copies, or overwrite one younger than 30
  days. Whether a write PAR can read an object by name wasn't confirmed;
  the copies are encrypted either way. Whether a write-only PAR may
  overwrite an object at all isn't stated in the docs; the retention
  rule blocks it regardless.
- They can upload junk under new names until the free 20 GB is full,
  after which real copies fail to upload. The junk is under the same
  30-day retention rule, so the owner gets rid of it by deleting the PAR,
  removing the rule, deleting the junk and adding the rule back: another
  reason the rule stays unlocked.
- Each upload attempt uses a new object name (the snapshot's time plus
  the attempt's), as the retention rule refuses a second `PUT` to a name
  for 30 days: a retry after a timeout whose upload had in fact reached
  Oracle would otherwise fail for that whole time. A lost response can
  leave two copies of one snapshot, which costs nothing that matters.
- The retention rule stays unlocked: locking is irreversible ("not even
  a tenancy administrator or Oracle Support can delete a locked rule"),
  which would make the 30 days permanent. Lifecycle can't delete objects
  under retention, so its 60 days must stay longer than the rule's 30.
  Versioning can't be on with a retention rule, and isn't needed.
- Losing the age identity makes every copy useless. The owner keeps it
  in their password manager (or another place off the VM), and the
  restore procedure in `ORACLE_CLOUD_DEPLOYMENT.md` (Next up item 1's
  other part) decrypts a real copy once, so a lost or wrong key shows
  up then, not during an outage.
- Setup is by hand, once, by the owner in Oracle's console: the bucket
  (private), the retention rule, the lifecycle policy and the policy
  that lets Object Storage run it, and the PAR. The PAR's URL is shown
  only once, goes straight into the VM's `.env`, and is a secret like the
  bot's token. It stops working if the user who made it is deleted or
  loses permission; it's renewed by making a new one and replacing the
  URL. `ORACLE_CLOUD_DEPLOYMENT.md` records the steps.
- A failed upload (Oracle down, a revoked PAR) is logged and never stops
  the bot. It's retried at most hourly, like a failed daily snapshot, but
  tracked on its own: the daily check skips once that day's snapshot
  exists, so the upload keeps its own record of the newest snapshot it
  has sent, kept across restarts (a marker file beside the snapshots, for
  instance), and sends the newest one not yet sent. The upload is the
  first network call in a scheduled check, so it takes the check's abort
  signal: shutdown stops it rather than waiting on a slow Oracle. Nobody
  reads the journal unprompted, so a PAR that stopped working could go
  unnoticed until a restore: alerting on failed backups is a later
  question, not part of this.
- One upload a day is about 30 requests a month of the 50,000, and the
  copies (about 60) are a tiny part of the 20 GB. A local dev bot
  without the two `.env` values skips uploading.
- Worth revisiting: if Oracle's Always Free Object Storage changes, if
  the database outgrows uploading whole copies, or if a copy outside
  Oracle is wanted.

## Sources

Read 2026-11-23.

- Oracle: [Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm),
  [pre-authenticated requests](https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/usingpreauthenticatedrequests.htm),
  [a PAR for all objects in a bucket](https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/usingpreauthenticatedrequests_topic-To_create_a_preauthenticated_request_for_all_objects_in_a_bucket.htm),
  [retention rules](https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/usingretentionrules.htm),
  [lifecycle policies](https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/usinglifecyclepolicies.htm),
  [Object Storage overview](https://docs.oracle.com/en-us/iaas/Content/Object/Concepts/objectstorageoverview.htm)
- Backblaze: [pricing](https://www.backblaze.com/cloud-storage/pricing),
  [transaction pricing](https://www.backblaze.com/cloud-storage/transaction-pricing),
  [Object Lock](https://www.backblaze.com/docs/cloud-storage-object-lock)
- Cloudflare: [R2 pricing](https://developers.cloudflare.com/r2/pricing/),
  [R2 get started](https://developers.cloudflare.com/r2/get-started/)
- GitHub: [large files](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github),
  [Acceptable Use Policies](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies)
- age: [README](https://github.com/FiloSottile/age),
  [specification](https://github.com/C2SP/C2SP/blob/main/age.md),
  [typage (`age-encryption`)](https://github.com/FiloSottile/typage)
  (its version and dependencies from `npm view`, as npmjs.com refused the
  fetch), [Ubuntu 24.04's `age`](https://packages.ubuntu.com/noble/age)
- Node.js 24: [`crypto`](https://nodejs.org/docs/latest-v24.x/api/crypto.html)
