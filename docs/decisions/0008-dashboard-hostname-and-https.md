# 0008: The dashboard is served at `shrimp-fried-rice.alexle.dev`, through a Cloudflare Tunnel

Status: Accepted · 2026-11-23

## Context

The dashboard ([Track D](../plans/minecraft-ff14-features.md#track-d-web-dashboard))
and two-way Minecraft chat ([0006](0006-discord-to-minecraft-chat.md))
need a public HTTPS endpoint for the bot: the browser for the pages and
Discord login, and `mcbridge`, which connects out to the bot. Discord's
OAuth2 redirect URL and the helper's config both hold the hostname, so it
has to stay the same across restarts, deploys and changes of hosting.
Today the VM accepts no inbound connections at all. The owner isn't
publishing the bot widely, so traffic is a few servers' pages and their
helpers' long polls.

D0 listed the hostname, HTTPS, and "proxy or tunnel" as separate
choices. They're one here: a tunnel brings its own hostname and
certificate, and a proxy needs a hostname from somewhere else.

CLAUDE.md allowed free tiers only, with nothing that needs a payment
method, which ruled out a bought domain. The first drafts of this record
(in PR #57's history) proposed a free deSEC name, then a free DuckDNS
name, each behind Caddy. On 2026-11-23 the owner chose instead to buy a
domain of their own, `alexle.dev`, at Porkbun, also used for their
portfolio and other projects. That is the one exception CLAUDE.md now
makes to free tiers only.
Porkbun lets a domain use another provider's nameservers, so its DNS can
be on Cloudflare's free plan while the registration stays independent
of Cloudflare.

Options, checked on 2026-11-23 against each provider's own docs (Sources,
below):

| Option | Cost | Inbound ports on the VM | Notes |
|---|---|---|---|
| **Cloudflare Tunnel on the owner's domain** | The domain ($8.75 the first year, $12.87 a year after, at Porkbun); Cloudflare's free plan | None: `cloudflared` on the VM connects out | Tunnel is "available on all plans"; it needs a domain on Cloudflare. Creating one asked for no payment method (the owner, in the dashboard, 2026-11-23), though Zero Trust onboarding asks for one even for its free plan. TLS ends at Cloudflare's edge, which decrypts requests to apply its firewall and caching. |
| Caddy on the VM, the owner's domain pointing at the VM's IP | The domain | 80 and 443 | Caddy gets Let's Encrypt certificates itself. Only the VM sees requests decrypted. The fallback (Consequences). |
| DuckDNS (`<name>.duckdns.org`) + Caddy | Free | 80 and 443 | Open for sign-ups. Run by two engineers; terms from 2018. Proposed in an earlier draft. |
| deSEC (`<name>.dedyn.io`) + Caddy | Free | 80 and 443 | Ruled out: `dedyn.io` registration is "suspended until further notice" after a wave of abusive sign-ups (the banner on desec.io, which the owner saw; its pages render in the browser only, so fetching them showed nothing). |
| A free `eu.org` domain on Cloudflare | Free | None | Usable: EU.org delegates names to any nameservers, and it's on the Public Suffix List, so Cloudflare's free plan should take `name.eu.org` as a domain (inferred from Cloudflare's rule; not stated). A person reviews each request, which "can take a few days". Superseded by buying a domain. |
| FreeDNS (afraid.org), `is-a.dev` | Free | — | Set aside: FreeDNS's shared domains belong to other members; `is-a.dev` refuses delegating to "DNS providers like Cloudflare". |
| Tailscale Funnel | Free (non-commercial) | None | Beta, bandwidth limits unpublished, long-lived requests undocumented. |
| Cloudflare quick tunnel | Free, no account | None | Ruled out: "for testing and development", a random hostname each run. |

Cloudflare's proxy on the free plan (checked 2026-11-23): it waits 125 s
for the origin to start answering (then error 524) and 30 s for writes,
and closes a connection idle for 900 s. WebSockets work on all plans.

`.dev` is on browsers' HTTPS-only list (from memory): every name under
`alexle.dev` must be served over HTTPS, which Cloudflare does.

## Decision

The owner's domain `alexle.dev` is registered at Porkbun, with its DNS
on Cloudflare's free plan. The dashboard and the helper's endpoint are
served at `https://shrimp-fried-rice.alexle.dev` through a Cloudflare
Tunnel: `cloudflared` runs on the VM as a systemd service, connects out
to Cloudflare, and passes requests to the bot on `127.0.0.1`. No inbound
port is opened on the VM. Creating the tunnel asked for no payment
method; if Cloudflare ever requires one, Caddy on the same name replaces
it (the fallback, below), as CLAUDE.md allows nothing else that needs
one.

**Why:**

A domain is something I'm sure a developer needs to go through getting at least once in their professional or hobby life. Despite the always free rule, I believe this is one of the acceptable exceptions to make for something that is common to deal with in the developer world. This also simplifies a lot of the project development process for a yearly cost I'm willing to foot for the foreseeable future. This also allows me to utilize and obtain Cloudflare experience as a professional with little exposure to it.

## Consequences

- The VM still accepts no inbound connections, and its IP isn't in DNS.
  Cloudflare's DDoS protection sits in front. Nothing on the VM handles
  certificates.
- Requests are decrypted at Cloudflare's edge before the tunnel carries
  them to the VM: the dashboard's pages and login cookies. Caddy instead
  would keep them to the VM. The helper's traffic is encrypted end to
  end on top of HTTPS ([0009](0009-dashboard-on-hono.md)), so relayed
  chat and the bridge's secret stay unreadable at the edge; Cloudflare
  sees only that a helper connects, when and how much. 0006 said the VM
  gains its first inbound endpoint; when this record is accepted, 0006's
  status becomes "superseded in part by
  [0008](0008-dashboard-hostname-and-https.md) (reached through a
  Cloudflare Tunnel with no inbound port; the helper's traffic is
  encrypted end to end across it)", in the index too.
- Setup is by hand, once, outside the deploy job. Done by the owner on
  2026-11-23: the domain added to Cloudflare (Porkbun's four parking
  records deleted) and its nameservers moved from Porkbun, now Active,
  and the tunnel created, with nothing connected to it. Left for D1: its
  route in Cloudflare's dashboard, and installing `cloudflared` with the
  tunnel's token, a secret on the VM like `.env`.
  `ORACLE_CLOUD_DEPLOYMENT.md` records each step in D1. The deploy job
  doesn't touch `cloudflared`, and updating it is a manual `apt` step.
- A deploy restarts the bot, not `cloudflared`: for those seconds
  Cloudflare answers with an error page, and the helper is designed to
  back off on a 5xx (A8). If `cloudflared` itself is down, the dashboard
  and every helper connection are down; Minecraft to Discord chat keeps
  working through webhooks.
- What the bot sees changes: every connection comes from `cloudflared`
  on `127.0.0.1`, so rate limits read the visitor's address from the
  header Cloudflare adds (`CF-Connecting-IP`, from memory; checked in
  D1). Cloudflare's bot-blocking features must not challenge `mcbridge`,
  which isn't a browser (checked when A8 is built).
- Long polls must be answered well within Cloudflare's 125 s
  ([0009](0009-dashboard-on-hono.md)).
- `alexle.dev` also hosts the owner's portfolio and other projects, each
  on its own name. Anything on another name under it can set cookies for
  the whole domain, so the dashboard's cookies are host-only (0009). The
  domain is a single point of failure for all of them: auto-renew on at
  Porkbun, and two-factor sign-in on both Porkbun and Cloudflare, since
  whoever controls the DNS controls where Discord's login sends users.
- Users see the owner's name in the dashboard's address, in Discord's
  login screen and in every helper's config. The owner chose that.
- Owning the domain makes the hosting replaceable without changing the
  hostname. If Cloudflare stops fitting (a payment requirement, a policy,
  an outage), the fallback is Caddy on the VM with the name pointing at
  its IP and ports 80 and 443 opened, with no change to Discord's
  redirect URL or any helper's config. That would supersede this record.
- The domain costs the owner $12.87 a year from the second year.

## Sources

Read 2026-11-23.

- Cloudflare: [Tunnel](https://developers.cloudflare.com/tunnel/),
  [Tunnel, get started](https://developers.cloudflare.com/tunnel/get-started/),
  [routing](https://developers.cloudflare.com/tunnel/routing/),
  [Zero Trust setup](https://developers.cloudflare.com/cloudflare-one/setup/),
  [quick tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/),
  [adding a domain](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/),
  [connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/),
  [error 524](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/),
  [WebSockets](https://developers.cloudflare.com/network/websockets/)
- Porkbun: [`.dev` pricing](https://porkbun.com/tld/dev),
  [changing nameservers](https://kb.porkbun.com/article/22-how-to-change-nameservers),
  [security](https://porkbun.com/security)
- Free names: [deSEC domains](https://desec.readthedocs.io/en/latest/dns/domains.html)
  (sign-ups suspended, per the banner on [desec.io](https://desec.io/)),
  [DuckDNS FAQ](https://www.duckdns.org/faqs.jsp),
  [EU.org registration](https://nic.eu.org/register.html),
  [is-a.dev FAQ](https://docs.is-a.dev/faq/),
  [FreeDNS FAQ](https://freedns.afraid.org/faq/),
  [Public Suffix List](https://publicsuffix.org/list/public_suffix_list.dat)
- Tailscale: [Funnel](https://tailscale.com/kb/1223/funnel)
- Caddy: [automatic HTTPS](https://caddyserver.com/docs/automatic-https);
  Let's Encrypt: [rate limits](https://letsencrypt.org/docs/rate-limits/)
- Oracle: [public IPs](https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/managingpublicIPs.htm),
  [compute best practices](https://docs.oracle.com/en-us/iaas/Content/Compute/References/bestpracticescompute.htm)
