<?php
/**
 * The hourly heartbeat — two jobs, one schedule.
 *
 * **1. Stay alive upstream.** Only `/quote` and `/verify` stamp in-app liveness on the control
 * plane. A WordPress site prices through `/quote` on every gated request, so a site with real
 * agent traffic stamps itself constantly — but a site that has just been set up, or one whose
 * articles are all free, would look like a dead integration and get flagged "reconnect your
 * SDK". Polling the status endpoint does not help: it deliberately stamps nothing. So the
 * heartbeat is a real `/quote` call for a real tolled resource.
 *
 * **2. Learn whether this host is in conflict.** A CNAME to the fleet plus in-app enforcement
 * tolls the same read twice. The control plane classifies that as `conflict`, and the enforcer
 * stands down when it sees it — but only if something fetches it. This is that something. The
 * verdict is cached in a transient with a lifetime several times the schedule, so one missed
 * cron tick cannot silently re-enable double-tolling.
 *
 * Both calls are best-effort. Nothing here can break the site: a failure is stored as a fact for
 * the diagnostics screen and retried on the next tick.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Cron {

	const EVENT = 'naulon_heartbeat';

	/** Transient the enforcer reads to stand down on a conflict. */
	const MODE_TRANSIENT = 'naulon_enforcement_mode';

	/** Deliberately several times the schedule: a missed tick must not silently un-stand-down. */
	const MODE_TTL = 21600; // 6 hours.

	/** @var Naulon_Cron|null */
	private static $instance = null;

	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	public function register() {
		add_action( self::EVENT, array( $this, 'run' ) );
		// Self-healing: if the event was lost (a cron plugin, a database restore, an upgrade that
		// missed activation), put it back. One transient-free option read on init.
		add_action( 'init', array( $this, 'ensure_scheduled' ) );
	}

	/**
	 * Schedule the heartbeat if it is not already scheduled and the site is connected. An
	 * unconnected site has nothing to call and must not phone home — that is a wordpress.org
	 * rule and the right default anyway.
	 *
	 * @return void
	 */
	public function ensure_scheduled() {
		if ( ! Naulon_Settings::is_connected() ) {
			$this->unschedule();
			return;
		}
		if ( ! wp_next_scheduled( self::EVENT ) ) {
			wp_schedule_event( time() + 300, 'hourly', self::EVENT );
		}
	}

	/**
	 * Remove the schedule. Deactivation, and any time the site is disconnected.
	 *
	 * @return void
	 */
	public function unschedule() {
		$timestamp = wp_next_scheduled( self::EVENT );
		while ( false !== $timestamp ) {
			wp_unschedule_event( $timestamp, self::EVENT );
			$timestamp = wp_next_scheduled( self::EVENT );
		}
	}

	/**
	 * One tick: reconcile ownership, refresh the classification, stamp liveness, then drain any
	 * audit reports a crawler request could not deliver.
	 *
	 * Ownership goes first on purpose — if this host lost its proof, the other two are describing
	 * an integration that cannot settle anything, and stamping liveness for it would keep it
	 * looking alive upstream.
	 *
	 * @return array The status result, for the admin "check now" button.
	 */
	public function run() {
		$this->reconcile_ownership();
		$status = $this->refresh_status();
		$this->stamp_liveness();
		// The published licence, refreshed only when the stored copy has aged past half its own
		// max-age. A crawler can trigger the same refresh from `/license.xml`, but a site with no
		// machine traffic still keeps current terms on the shelf.
		Naulon_License::instance()->refresh();
		// Last, and only ever a drain of what a crawler request could not deliver. A site with a
		// trickle of machine traffic would otherwise hold a failed batch until the next crawl,
		// which on a quiet site can be days. Nothing is recorded here — see Naulon_Observer.
		Naulon_Observer::instance()->flush();
		return $status;
	}

	/**
	 * Does the control plane still hold an ownership proof for this host?
	 *
	 * The enforcer gates on the LOCAL `verified_at` (`Naulon_Enforcer::should_toll`), and nothing
	 * ever re-read it. The control plane can withdraw the proof on its own: its re-verify sweep
	 * demotes a host that stops serving the challenge for longer than the grace window, and the
	 * trigger is the failure this plugin's own diagnostics call the common one — a security or
	 * static-file plugin swallowing `/.well-known/`. Removing the domain in the dashboard has the
	 * same effect.
	 *
	 * Both used to leave the two sides silently disagreeing: the control plane says unverified, so
	 * `/verify` answers `resource not owned by this key` and no payment can ever settle — while
	 * this plugin, still believing itself verified, keeps answering agents with a 402. Every agent
	 * loops pay → rejected, the site earns nothing, and the setup screen shows a green **Verified**
	 * pill over the whole thing. Nothing surfaced it and nothing recovered from it.
	 *
	 * The read costs one call on a scope the setup key KEEPS: listing challenges needs `tenant.read`,
	 * not the `domain.manage` the control plane takes back once setup succeeds. So this works with
	 * the credential already in the options table, for the whole life of the key.
	 *
	 * Conservative in exactly one direction. Only an authoritative answer clears anything: a
	 * transport failure, a 401/403, or a malformed body all leave local state untouched, because
	 * un-verifying a healthy site over a network hiccup would take a working toll offline. A list
	 * that comes back fine and simply does not carry a verified proof for this host is the
	 * authoritative "no" — including the host being absent entirely, which is what a deleted
	 * domain looks like.
	 *
	 * @return bool True when this tick cleared a stale local verification.
	 */
	public function reconcile_ownership() {
		if ( ! Naulon_Settings::is_connected() || ! Naulon_Settings::is_verified() ) {
			return false; // nothing to reconcile — there is no local claim to withdraw.
		}

		$response = Naulon_Client::instance()->list_challenges();
		if ( ! $response['ok'] || ! isset( $response['body']['challenges'] ) || ! is_array( $response['body']['challenges'] ) ) {
			return false; // unreadable ⇒ no evidence ⇒ never touch a working verification.
		}

		$host = Naulon_Verification::host();
		foreach ( $response['body']['challenges'] as $challenge ) {
			if ( ! is_array( $challenge ) || ! isset( $challenge['host'] ) ) {
				continue;
			}
			if ( strtolower( (string) $challenge['host'] ) !== $host ) {
				continue;
			}
			$verified = isset( $challenge['verifiedAt'] ) && '' !== (string) $challenge['verifiedAt'];
			if ( $verified ) {
				return false; // both sides agree — the normal path, and the common one.
			}
			break;
		}

		// Either the host is gone from the list, or its proof is null. Stand down: clear the local
		// verification so the enforcer stops issuing 402s nothing can settle, and record WHY so the
		// setup screen can say "this was verified and is not any more" rather than "not verified".
		Naulon_Settings::update(
			array(
				'verified_at'       => '',
				'ownership_lost_at' => gmdate( 'c' ),
			)
		);
		return true;
	}

	/**
	 * Ask the control plane how it classifies every host this key owns, and remember the verdict
	 * for ours.
	 *
	 * @return array {ok:bool, mode:string, next_action:string, attention:bool, message:string}
	 */
	public function refresh_status() {
		$response = Naulon_Client::instance()->enforce_status();
		$host     = Naulon_Verification::host();

		if ( ! $response['ok'] || ! isset( $response['body']['hosts'] ) || ! is_array( $response['body']['hosts'] ) ) {
			$result = array(
				'ok'          => false,
				'mode'        => '',
				'next_action' => '',
				'attention'   => false,
				'message'     => $this->status_error( $response ),
			);
			Naulon_Settings::update(
				array(
					'status_checked_at' => gmdate( 'c' ),
					'status_mode'       => '',
					'status_next_action' => '',
					'status_error'      => $result['message'],
				)
			);
			return $result;
		}

		$row = null;
		foreach ( $response['body']['hosts'] as $candidate ) {
			if ( isset( $candidate['host'] ) && strtolower( (string) $candidate['host'] ) === $host ) {
				$row = $candidate;
				break;
			}
		}

		// A host the control plane has never classified is not an error: a brand-new site simply
		// has no verdict yet. Store the absence rather than inventing a mode.
		$mode        = ( is_array( $row ) && isset( $row['mode'] ) && is_string( $row['mode'] ) ) ? $row['mode'] : '';
		$next_action = ( is_array( $row ) && isset( $row['nextAction'] ) ) ? (string) $row['nextAction'] : '';
		$attention   = is_array( $row ) && ! empty( $row['attention'] );

		set_transient( self::MODE_TRANSIENT, $mode, self::MODE_TTL );
		Naulon_Settings::update(
			array(
				'status_checked_at'  => gmdate( 'c' ),
				'status_mode'        => $mode,
				'status_next_action' => $next_action,
				'status_error'       => '',
			)
		);

		return array(
			'ok'          => true,
			'mode'        => $mode,
			'next_action' => $next_action,
			'attention'   => $attention,
			'message'     => '',
		);
	}

	/**
	 * Price one real tolled resource so the control plane sees this integration is alive.
	 *
	 * Deliberately a `/quote` for an article that would actually be tolled: a made-up resource
	 * would answer 204 (don't gate) and prove nothing about the path that matters.
	 *
	 * @return bool Whether a resource was found and quoted.
	 */
	public function stamp_liveness() {
		$post = $this->heartbeat_post();
		if ( ! $post instanceof WP_Post ) {
			Naulon_Settings::update( array( 'heartbeat_at' => gmdate( 'c' ), 'heartbeat_note' => 'no tollable post' ) );
			return false;
		}

		$credits  = Naulon_Credits::instance();
		$response = Naulon_Client::instance()->quote( get_permalink( $post ), $credits->canonical_slug_for( $post ), 'read' );

		Naulon_Settings::update(
			array(
				'heartbeat_at'   => gmdate( 'c' ),
				'heartbeat_note' => $response['ok'] ? '' : $this->status_error( $response ),
			)
		);
		return $response['ok'];
	}

	/**
	 * The most recently published post that would actually be tolled.
	 *
	 * @return WP_Post|null
	 */
	private function heartbeat_post() {
		$credits = Naulon_Credits::instance();
		$posts   = get_posts(
			array(
				'post_type'        => $credits->tollable_post_types(),
				'post_status'      => 'publish',
				'numberposts'      => 10,
				'suppress_filters' => false,
			)
		);
		foreach ( $posts as $post ) {
			if ( $credits->is_tollable( $post ) && ! empty( $credits->contributors_for( $post ) ) ) {
				return $post;
			}
		}
		return null;
	}

	/**
	 * A status-call failure, said plainly.
	 *
	 * @param array $response Client response.
	 * @return string
	 */
	private function status_error( array $response ) {
		if ( 401 === $response['status'] ) {
			return __( 'The control plane rejected this API key (401). Nothing is being tolled until it is replaced.', 'naulon' );
		}
		if ( 0 === $response['status'] ) {
			/* translators: %s: transport error. */
			return sprintf( __( 'Could not reach the control plane: %s', 'naulon' ), $response['error'] );
		}
		/* translators: %d: HTTP status code. */
		return sprintf( __( 'The control plane answered %d.', 'naulon' ), $response['status'] );
	}
}
