=== naulon — citation toll ===
Contributors: naulon
Tags: ai, monetization, paywall, crawlers, licensing
Requires at least: 6.2
Tested up to: 7.0
Requires PHP: 7.4
Stable tag: 0.3.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Charge AI agents for reading your articles. Humans always read free, and your authors get paid directly.

== Description ==

AI agents read your work to answer questions. They do not click your ads, they do not subscribe, and they rarely send a reader back. naulon prices that read.

A human visitor is never affected. They see exactly what they always saw, at the same speed. An automated agent asking for the full text of an article gets a price instead, pays it, and then reads. What it pays goes to the people credited on that article — straight to their wallets, with nothing pooled or held in between.

**How it decides**

* Human traffic reads free. This is not a setting and there is no switch to change it.
* Titles, excerpts, your sitemap and your feeds stay free — agents need to find you.
* Full article text is what carries a price.
* An article with no wallet behind it reads free. Nothing is ever charged with nowhere to send it.

**What you configure**

You paste one key, click verify, and choose what is tolled. Your authors each add their own wallet address from their normal WordPress profile — an author never sees anyone else's earnings, and only editors and administrators can see the site's total.

**How you know it is working**

The Setup screen has a **Test toll** button that asks your own site for one of your articles while presenting a crawler's user agent, over real HTTP, and shows you what came back: the status, the price, the chain, and the wallet being paid. Diagnostics runs the same check against caching, lists the last decisions the toll made — machine requests only, readers are never logged — and says plainly when something between the internet and WordPress is answering from a cache.

**Where the money goes**

Payment is direct: the agent pays your authors. This plugin never takes custody of funds, never holds a balance, and never asks you to top anything up. There is no wallet on this site holding money.

**Self-hosting**

The whole protocol is open source. The connectivity field takes either a hosted key or the URL of a gate you run yourself, and everything else works identically.

== Installation ==

1. Install and activate the plugin. Later versions arrive on the Plugins screen like any other update — you only download a zip this once.
2. Open **naulon → Setup** and paste your key.
3. Click **Verify this site**. The plugin proves you own the domain by serving a challenge file and a meta tag — no DNS changes needed.
4. Paste the credits address shown on that screen into your naulon account, so the service knows where to read your author data.
5. Switch the toll on, and press **Test toll** to watch a crawler get charged.
6. Choose what is tolled under **naulon → Content**.
7. Ask your authors to add a wallet address to their profile. Posts by authors without one read free.

Permalinks must not be set to Plain — with plain permalinks an article has no address to identify it by, and nothing can be tolled. The Setup screen says so if that is the case.

If anything caches pages on your site, install the cache guard from **naulon → Diagnostics**. A cached article is served before any plugin runs, so without it crawlers can read from the cache for free.

For the strongest key storage, add it to `wp-config.php` instead of the settings screen:

`define( 'NAULON_API_KEY', 'nln_live_…' );`

A key in `wp-config.php` stays out of your database, so it does not travel in database exports or backups. The settings screen will tell you which storage is in use.

== External services ==

This plugin relies on an external service to price a read and to settle a payment, because
settlement cannot be performed inside WordPress. Nothing is contacted until you enter a key —
entering it is the consent, and until then the plugin makes no outbound requests at all.

**Service:** naulon (https://naulon.app), reached at https://gate.naulon.app.

**When it is contacted, and what is sent:**

* When you connect or rotate a key, and hourly thereafter, to confirm the connection is live.
  Sent: your API key and your site's domain.
* When you verify ownership of your site. Sent: your API key and your site's domain. The
  service then fetches a challenge file or your homepage to confirm you control the domain.
* When an automated agent requests a full article and a price is needed. Sent: your API key,
  the URL and slug of the requested article.
* When an agent pays. Sent: your API key, the article URL, the payment the agent signed, and
  the wallet addresses credited on that article.

**What is never sent:** your article content, your readers, your visitor logs, and anything
about human traffic. Human requests never contact the service at all.

If you point the connectivity field at your own self-hosted gate instead of a key, the plugin
talks only to that server and never to naulon.app.

**Service:** GitHub (https://github.com), for updates only.

This plugin is not listed on wordpress.org, so WordPress cannot ask wordpress.org whether a new
version exists. Instead it reads a small file describing the current release, published beside the
download on GitHub. This is the only outbound request the plugin makes before you enter a key.

* When WordPress checks for plugin updates (twice a day, and when you click "Check again"), the
  plugin fetches https://github.com/naulonapp/naulon/releases/latest/download/naulon-update.json.
  It is a public file. **Nothing is sent** — no key, no domain, no site information — beyond the
  request itself, and the answer is cached for six hours.
* When you choose to install an update, WordPress downloads the release zip from the same place.

GitHub terms of service: https://docs.github.com/site-policy/github-terms/github-terms-of-service
GitHub privacy statement: https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement

Terms of service: https://naulon.app/terms
Privacy policy: https://naulon.app/privacy

== Frequently Asked Questions ==

= Will this slow down or break my site for readers? =

No. Human requests are not touched, and if the control plane is unreachable the plugin serves everything normally rather than failing. A plugin that breaks a site is a plugin nobody keeps.

= Do I need to understand crypto to use this? =

You need a wallet address to receive payments — the same way you would need a bank account number. Nothing else.

= What if my authors do not have wallets? =

Their posts read free. That is the deliberate behaviour: nothing is charged when there is nobody to pay.

= Does this block search engines? =

No. Search crawlers reading titles, excerpts and feeds are unaffected, and those surfaces are free by design.

= I already sell memberships. Will readers be charged twice? =

No. Content behind a membership plugin is excluded, and there is a filter (`naulon_is_tollable`) for anything custom.

= Does the plugin send my content anywhere? =

No. Your content never leaves your server. The plugin talks to the control plane only to price a read and to settle a payment, and it does not contact anything at all until you enter a key.

= Does it log my visitors? =

No. Human requests are never recorded — not their address, not their browser, not the fact that they arrived. The Diagnostics screen lists recent decisions, and every line on it is a machine.

= How do I update the plugin? =

The same way as any other: **Dashboard → Updates**, or the notice on the Plugins screen. Turning on "Enable auto-updates" there works too. Because the plugin is not listed on wordpress.org it checks a small public file on GitHub instead of the wordpress.org API — that is the only difference, and it needs nothing from you. Version 0.3.0 is the first release that can do this, so if you are on an earlier one, install that one by hand and it is the last time.

= I use a caching plugin. Does that matter? =

Yes, and the plugin is direct about it. A page cache answers before any plugin runs, so a cached article can be handed to a crawler for free. Install the cache guard from Diagnostics — it stops agent responses being cached at all — then add the listed user agents to your caching plugin's own exclusion list, and use the check on that screen to confirm a crawler is actually being charged.

== Screenshots ==

1. Setup — connect, verify, switch on, and test the toll against your own site.
2. Content — choose what is tolled and which machines are charged.
3. People — which authors have wallets, and how many posts read free without one.
4. Earnings — what has been paid, per author, settled and authorized shown separately.
5. Diagnostics — the caching check, recent decisions, and connection health.

== Changelog ==

= 0.3.0 =
* Updates now arrive in WordPress. The Plugins screen tells you when a new version is out, updates in one click, and can update itself — no downloading a zip and uploading it over the top.
* The details link on that notice opens the real changelog, so you can read what changed before you take it.

= 0.2.3 =
* A shared cache could hand a crawler the copy it made for a human, so a read that should have been paid was served free. The cache guard now varies on what the toll actually decides on.
* The toll test named two wrong causes and never the real one — a network edge in front of your site turning the crawler away before it ever reaches WordPress. It now names that, and what to change.
* The version in the plugin header, the readme and the code is checked against the last release, so a build can no longer ship under a version you already have.

= 0.2.0 =
* Refuse in-app enforcement on a domain the naulon fleet already tolls, so one read is never charged twice.
* Reconcile ownership on the hourly heartbeat: a proof withdrawn in the dashboard now stands the toll down here.
* A spent connect key reads as finished instead of failing — the key drops its domain-management scope once the domain verifies.
* Clearer message when a key cannot claim domains, naming the key preset that can.

= 0.1.0 =
* First release: credits contract, author wallets, site ownership verification, roles and capabilities.
* Admin screens: setup with one-click verification and a real toll test, content policy, author payouts, earnings, diagnostics.
* Cache guard drop-in, plus a live check that tells you whether a crawler is actually being charged.
* Hourly heartbeat that keeps the connection alive and stands the toll down if DNS-based enforcement is already charging for the same domain.

== Upgrade Notice ==

= 0.3.0 =
The last update you have to install by hand. From here WordPress offers new versions on the Plugins screen and can install them for you.

= 0.2.3 =
Stops a shared cache serving a paid read for free, and the toll test now names an edge block instead of two wrong causes.

= 0.2.0 =
Stops a domain being charged twice when the fleet already tolls it, and notices when you withdraw a domain proof.

= 0.1.0 =
First release.
