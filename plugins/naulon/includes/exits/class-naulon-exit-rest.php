<?php
/**
 * The REST door: `/wp-json/wp/v2/<type>` (and `?rest_route=`) returns each post's rendered body,
 * in lists as well as single posts. For a requester the toll would charge, a sold post's body is
 * replaced by its excerpt and marked protected, the way WordPress marks a password-protected post.
 * The single-post route still answers 402 first (`Naulon_Enforcer::guard_rest`), so this governs the
 * lists, `?slug=` lookups and `_embed`ded posts that route never sees.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Exit_Rest implements Naulon_Content_Exit {

	/** @var Naulon_Exits */
	private $exits;

	/** @var bool Did this request's response lose a body? */
	private $stripped = false;

	public function id() {
		return 'wordpress-rest';
	}

	public function register( $exits ) {
		$this->exits = $exits;
		add_action(
			'rest_api_init',
			function () {
				foreach ( Naulon_Credits::instance()->tollable_post_types() as $type ) {
					add_filter( "rest_prepare_{$type}", array( $this, 'prepare' ), 10, 3 );
				}
			}
		);
		add_filter( 'rest_post_dispatch', array( $this, 'headers' ), 10, 3 );
	}

	/**
	 * @param WP_REST_Response $response The prepared post.
	 * @param WP_Post          $post     The post.
	 * @param WP_REST_Request  $request  The request.
	 * @return WP_REST_Response
	 */
	public function prepare( $response, $post, $request ) {
		if ( ! $this->exits->sells( $post ) || ! $this->exits->charges_requester() ) {
			return $response;
		}
		$data = $response->get_data();
		if ( ! isset( $data['content'] ) || ! is_array( $data['content'] ) ) {
			return $response;
		}
		$data['content']['rendered']  = isset( $data['excerpt']['rendered'] ) && is_string( $data['excerpt']['rendered'] )
			? $data['excerpt']['rendered']
			: wpautop( esc_html( Naulon_Exits::teaser( $post ) ) );
		$data['content']['protected'] = true;
		$response->set_data( $data );
		$this->stripped = true;
		return $response;
	}

	/**
	 * Every post route answers by who asked, so every cache must keep the answers apart; a stripped
	 * one is never stored at all.
	 *
	 * @param WP_REST_Response $response The response.
	 * @param WP_REST_Server   $server   The server.
	 * @param WP_REST_Request  $request  The request.
	 * @return WP_REST_Response
	 */
	public function headers( $response, $server, $request ) {
		if ( 0 !== strpos( (string) $request->get_route(), '/wp/v2/' ) || ! $response instanceof WP_REST_Response ) {
			return $response;
		}
		$existing = isset( $response->get_headers()['Vary'] ) ? (string) $response->get_headers()['Vary'] : '';
		$response->header( 'Vary', Naulon_Enforcer::merge_vary( $existing ) );
		if ( $this->stripped ) {
			$response->header( 'Cache-Control', 'private, no-store' );
			$response->header( Naulon_Exits::HEADER, $this->id() );
		}
		return $response;
	}
}
