<?php
/**
 * Plugin Name: naulon cache guard
 * Description: Keeps page caches off machine requests, so an agent is never served a cached copy of a tolled article — and a human is never served a cached 402. Installed by the naulon plugin; safe to delete.
 * Version: 1
 *
 * ---------------------------------------------------------------------------------------------
 * THIS FILE IS INSTALLED, NOT EDITED. The naulon plugin writes it into mu-plugins/ and the
 * marker below lets it recognize its own copy and replace an outdated one. Edits will be lost.
 * ---------------------------------------------------------------------------------------------
 *
 * Why a must-use plugin at all, and — just as important — what it can and cannot do.
 *
 * A page cache turns a WordPress request into a static file. That is exactly what a publisher
 * wants for readers and exactly wrong for a toll: a cached article is an untolled article, and a
 * cached 402 is a paywall shown to a human. This file runs at mu-plugin load, which is before
 * every normal plugin including every cache plugin's own code, so the "do not cache this
 * response" constants are already set by the time any of them decide whether to store the page.
 *
 * **What it cannot do, stated plainly because the alternative is a false sense of safety.**
 * WordPress loads `advanced-cache.php` (the full-page cache drop-in) BEFORE mu-plugins. A cache
 * HIT is served and the request ends there — this file never runs. So this guard reliably stops
 * agent responses from being *stored*; it cannot stop a page already in the cache from being
 * *served* to an agent. Closing that second hole needs the cache layer's own user-agent
 * exclusion, which is per-product configuration, and the plugin's Diagnostics screen tests
 * whether it is actually in place by asking the site for a tolled article as a crawler and
 * looking at what comes back. A guess would be worse than nothing here.
 *
 * Failure posture: if anything is missing or unreadable, this file does nothing at all. It must
 * never be the reason a site fails to load.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

define( 'NAULON_CACHE_GUARD_VERSION', 1 );

/**
 * The classifier lives in the plugin and is pinned to the upstream TypeScript by a parity test.
 * This path is written at install time so there is exactly ONE user-agent list on this site — a
 * second copy here would drift, and a drifted copy decides which readers get charged.
 */
if ( ! defined( 'NAULON_AGENT_CLASS_PATH' ) ) {
	define( 'NAULON_AGENT_CLASS_PATH', '{{AGENT_CLASS_PATH}}' );
}

/**
 * Mark this request uncacheable for every layer we know how to talk to. Called only for machine
 * requests: a human request is left completely alone, so the cache serves readers at full speed.
 *
 * @return void
 */
function naulon_cache_guard_do_not_cache() {
	// The near-universal signal: WP Super Cache, W3 Total Cache, WP Rocket, Batcache, LiteSpeed
	// and Cache Enabler all honor it.
	if ( ! defined( 'DONOTCACHEPAGE' ) ) {
		define( 'DONOTCACHEPAGE', true );
	}
	if ( ! defined( 'DONOTCACHEOBJECT' ) ) {
		define( 'DONOTCACHEOBJECT', true );
	}
	if ( ! defined( 'DONOTCACHEDB' ) ) {
		define( 'DONOTCACHEDB', true );
	}
	// Optimizers rewrite the response body; on a 402 there is nothing worth rewriting and the
	// pass costs latency an agent is waiting on.
	if ( ! defined( 'DONOTMINIFY' ) ) {
		define( 'DONOTMINIFY', true );
	}
	if ( ! defined( 'DONOTROCKETOPTIMIZE' ) ) {
		define( 'DONOTROCKETOPTIMIZE', true );
	}
	// LiteSpeed's server-level cache reads its own constant.
	if ( ! defined( 'LSCACHE_NO_CACHE' ) ) {
		define( 'LSCACHE_NO_CACHE', true );
	}
}

/**
 * Decide, as cheaply as possible, whether this request is a machine.
 *
 * @return void
 */
function naulon_cache_guard_run() {
	// A request with no user agent and no payment header is not worth a file read.
	$has_payment = isset( $_SERVER['HTTP_PAYMENT_SIGNATURE'] ) || isset( $_SERVER['HTTP_X_NAULON_AGENT'] );
	if ( ! $has_payment && empty( $_SERVER['HTTP_USER_AGENT'] ) ) {
		return;
	}
	// A declared agent needs no classification at all.
	if ( $has_payment ) {
		naulon_cache_guard_do_not_cache();
		return;
	}

	if ( ! class_exists( 'Naulon_Agent' ) ) {
		if ( ! is_readable( NAULON_AGENT_CLASS_PATH ) ) {
			return; // Plugin moved, renamed or removed. Do nothing; the site is unaffected.
		}
		require_once NAULON_AGENT_CLASS_PATH;
	}
	if ( ! class_exists( 'Naulon_Agent' ) ) {
		return;
	}

	// The publisher's own allow/charge lists are not read here: they live in an option, and
	// loading options this early is both expensive and unreliable. The built-in list is a strict
	// subset of what the plugin will charge, so the worst case is that a publisher-charged
	// crawler's response gets cached — under-tolling, never over-tolling a human.
	$verdict = Naulon_Agent::classify(
		array(
			'user_agent'         => isset( $_SERVER['HTTP_USER_AGENT'] ) ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_USER_AGENT'] ) ) : '',
			'accept'             => isset( $_SERVER['HTTP_ACCEPT'] ) ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_ACCEPT'] ) ) : '',
			'has_payment_header' => false,
			'declared_agent_id'  => '',
			'headers'            => array(),
		)
	);

	if ( isset( $verdict['kind'] ) && 'agent' === $verdict['kind'] ) {
		naulon_cache_guard_do_not_cache();
	}
}

naulon_cache_guard_run();
