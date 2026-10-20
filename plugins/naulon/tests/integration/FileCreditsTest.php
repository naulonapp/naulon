<?php
/**
 * The credits and catalog contracts for a file in the media library.
 *
 * A file is credited to the work it belongs to: its parent post's authors and that post's toll
 * verdict. An unattached file is credited to whoever uploaded it. A type the publisher did not opt
 * in is never described, so the gate reads it free.
 *
 * @package naulon
 */

class FileCreditsTest extends WP_UnitTestCase {

	const WALLET_A = '0x1111111111111111111111111111111111111111';
	const WALLET_B = '0x2222222222222222222222222222222222222222';

	/** @var int */
	private $author;

	/** @var int */
	private $uploader;

	public function set_up() {
		parent::set_up();
		$this->author = self::factory()->user->create( array( 'role' => 'author' ) );
		update_user_meta( $this->author, Naulon_Credits::USER_WALLET_META, self::WALLET_A );
		$this->uploader = self::factory()->user->create( array( 'role' => 'author' ) );
		update_user_meta( $this->uploader, Naulon_Credits::USER_WALLET_META, self::WALLET_B );
		update_option( Naulon_Rules::FILE_TYPES_OPTION, array( 'pdf' ) );
		update_option( 'permalink_structure', '/%postname%/' );
		do_action( 'rest_api_init' );
	}

	public function tear_down() {
		delete_option( Naulon_Rules::FILE_TYPES_OPTION );
		update_option( 'permalink_structure', '' );
		parent::tear_down();
	}

	private function credits( $slug ) {
		$request = new WP_REST_Request( 'GET', '/naulon/v1/credits/' . $slug );
		$request->set_url_params( array( 'slug' => $slug ) );
		return rest_get_server()->dispatch( $request );
	}

	/** Every entry, following the cursor to the end: files page after posts. */
	private function catalog_entries() {
		$entries = array();
		$cursor  = null;
		do {
			$request = new WP_REST_Request( 'GET', '/naulon/v1/catalog' );
			if ( null !== $cursor ) {
				$request->set_param( 'cursor', $cursor );
			}
			$data    = rest_get_server()->dispatch( $request )->get_data();
			$entries = array_merge( $entries, $data['entries'] );
			$cursor  = isset( $data['nextCursor'] ) ? $data['nextCursor'] : null;
		} while ( null !== $cursor );
		return $entries;
	}

	private function post( array $over = array() ) {
		return self::factory()->post->create(
			array_merge(
				array(
					'post_author' => $this->author,
					'post_name'   => 'the-paper',
					'post_title'  => 'The paper',
					'post_status' => 'publish',
				),
				$over
			)
		);
	}

	private function file( $parent, $name = 'stage-toll.pdf', $mime = 'application/pdf' ) {
		$id = self::factory()->attachment->create_object(
			$name,
			$parent,
			array(
				'post_mime_type' => $mime,
				'post_author'    => $this->uploader,
				'post_title'     => 'Stage toll',
			)
		);
		update_attached_file( $id, '2026/09/' . $name );
		return $id;
	}

	public function test_file_attached_to_tollable_post_credits_parent_authors() {
		$this->file( $this->post() );

		$response = $this->credits( 'wp-content/uploads/2026/09/stage-toll.pdf' );
		$this->assertSame( 200, $response->get_status() );
		$data = $response->get_data();
		$this->assertSame( array( 'slug', 'title', 'contributors' ), array_keys( $data ) );
		$this->assertSame( 'wp-content/uploads/2026/09/stage-toll.pdf', $data['slug'] );
		$this->assertSame( 'wp-user-' . $this->author, $data['contributors'][0]['authorId'] );
		$this->assertSame( self::WALLET_A, $data['contributors'][0]['wallet'] );
	}

	public function test_file_type_not_opted_in_is_free() {
		$this->file( $this->post() );
		update_option( Naulon_Rules::FILE_TYPES_OPTION, array() );

		$this->assertSame( 404, $this->credits( 'wp-content/uploads/2026/09/stage-toll.pdf' )->get_status() );
	}

	public function test_file_on_free_post_is_free() {
		$parent = $this->post();
		update_post_meta( $parent, Naulon_Credits::POST_TOLL_META, 'free' );
		$this->file( $parent );

		$this->assertSame( 404, $this->credits( 'wp-content/uploads/2026/09/stage-toll.pdf' )->get_status() );
	}

	public function test_file_on_unpublished_post_is_free() {
		$this->file( $this->post( array( 'post_status' => 'draft' ) ) );

		$this->assertSame( 404, $this->credits( 'wp-content/uploads/2026/09/stage-toll.pdf' )->get_status() );
	}

	public function test_unattached_file_credits_uploader() {
		$this->file( 0 );

		$response = $this->credits( 'wp-content/uploads/2026/09/stage-toll.pdf' );
		$this->assertSame( 200, $response->get_status() );
		$data = $response->get_data();
		$this->assertSame( 'wp-user-' . $this->uploader, $data['contributors'][0]['authorId'] );
		$this->assertSame( self::WALLET_B, $data['contributors'][0]['wallet'] );
	}

	public function test_a_path_outside_uploads_is_never_a_file() {
		$this->file( $this->post() );

		$this->assertSame( 404, $this->credits( 'wp-content/plugins/naulon/stage-toll.pdf' )->get_status() );
	}

	public function test_an_unknown_file_is_free() {
		$this->assertSame( 404, $this->credits( 'wp-content/uploads/2026/09/missing.pdf' )->get_status() );
	}

	public function test_catalog_lists_tollable_files_after_posts() {
		$parent = $this->post();
		$this->file( $parent );
		$free = $this->post( array( 'post_name' => 'free-one' ) );
		update_post_meta( $free, Naulon_Credits::POST_TOLL_META, 'free' );
		$this->file( $free, 'free-file.pdf' );

		$entries = $this->catalog_entries();
		$slugs   = wp_list_pluck( $entries, 'slug' );
		$this->assertContains( 'the-paper', $slugs );
		$this->assertContains( 'wp-content/uploads/2026/09/stage-toll.pdf', $slugs );
		$this->assertNotContains( 'wp-content/uploads/2026/09/free-file.pdf', $slugs );

		$file = $entries[ array_search( 'wp-content/uploads/2026/09/stage-toll.pdf', $slugs, true ) ];
		$this->assertSame( 'wp-user-' . $this->author, $file['authors'][0]['id'] );
		$this->assertStringEndsWith( '/wp-content/uploads/2026/09/stage-toll.pdf', $file['url'] );
	}

	public function test_catalog_lists_no_files_when_none_are_opted_in() {
		$this->file( $this->post() );
		update_option( Naulon_Rules::FILE_TYPES_OPTION, array() );

		$slugs = wp_list_pluck( $this->catalog_entries(), 'slug' );
		$this->assertNotContains( 'wp-content/uploads/2026/09/stage-toll.pdf', $slugs );
	}
}
