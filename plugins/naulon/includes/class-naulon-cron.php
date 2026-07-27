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
	 * One tick: refresh the classification, then stamp liveness.
	 *
	 * @return array The status result, for the admin "check now" button.
	 */
	public function run() {
		$status = $this->refresh_status();
		$this->stamp_liveness();
		return $status;
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
