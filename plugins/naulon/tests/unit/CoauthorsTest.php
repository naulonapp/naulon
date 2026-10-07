<?php
/**
 * Multi-author bylines become contributors. Every case here decides whose wallet an agent's payment
 * for a co-written post reaches, and under which id the catalog lists them.
 *
 * The object shapes are the ones each plugin really returns, read from its source: Co-Authors Plus
 * (`type`, `ID`, `wp_user`), PublishPress Authors (`ID` negative for a guest) and Molongui
 * (`user-<id>` / `guest-<id>` meta values).
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class CoauthorsTest extends TestCase {

	private static function wp_user( $id, $name = '' ) {
		return (object) array( 'ID' => $id, 'type' => 'wpuser', 'display_name' => $name );
	}

	private static function cap_guest( $id, $linked_user_id = null ) {
		$g = (object) array( 'ID' => $id, 'type' => 'guest-author', 'display_name' => 'Guest ' . $id );
		if ( null !== $linked_user_id ) {
			$g->wp_user = (object) array( 'ID' => $linked_user_id );
		}
		return $g;
	}

	/** A PublishPress Author: positive ID is the user, a guest's ID is its negated term id. */
	private static function ppa_author( $id, $name ) {
		return (object) array( 'ID' => $id, 'display_name' => $name );
	}

	public function test_co_authors_plus_registered_authors_and_an_unlinked_guest() {
		$this->assertSame(
			array(
				array( 'user_id' => 2, 'name' => 'Ada' ),
				array( 'guest_id' => 90, 'name' => 'Guest 90' ),
			),
			Naulon_Authors::from_objects( array( self::wp_user( 2, 'Ada' ), self::cap_guest( 90 ) ) )
		);
	}

	public function test_a_guest_linked_to_an_account_is_that_account_and_counted_once() {
		$this->assertSame(
			array( array( 'user_id' => 7, 'name' => 'Ben' ) ),
			Naulon_Authors::from_objects( array( self::wp_user( 7, 'Ben' ), self::cap_guest( 91, 7 ) ) )
		);
	}

	public function test_publishpress_negative_ids_are_guests_not_users() {
		$this->assertSame(
			array(
				array( 'user_id' => 3, 'name' => 'Cleo' ),
				array( 'guest_id' => 44, 'name' => 'Dev' ),
			),
			Naulon_Authors::from_objects( array( self::ppa_author( 3, 'Cleo' ), self::ppa_author( -44, 'Dev' ) ) )
		);
	}

	public function test_molongui_refs_in_stored_order_once_each() {
		$this->assertSame(
			array( array( 'guest_id' => 34 ), array( 'user_id' => 12 ) ),
			Naulon_Authors::from_molongui_refs( array( 'guest-34', 'user-12', 'guest-34', 'nonsense', 'user-0' ) )
		);
	}

	public function test_one_id_spelling_for_payment_and_catalog() {
		$this->assertSame( 'wp-user-2', Naulon_Authors::author_id( array( 'user_id' => 2 ) ) );
		$this->assertSame( 'wp-guest-90', Naulon_Authors::author_id( array( 'guest_id' => 90 ) ) );
	}

	public function test_nothing_usable_means_no_multi_author_answer() {
		$this->assertSame( array(), Naulon_Authors::from_objects( array() ) );
		$this->assertSame( array(), Naulon_Authors::from_objects( array( 'not-an-object', (object) array(), self::wp_user( 0 ) ) ) );
		$this->assertSame( array(), Naulon_Authors::from_objects( false ) );
	}

	public function test_catalog_cursor_round_trips_and_defaults_to_page_one() {
		$this->assertSame( 3, Naulon_Credits::page_from_cursor( Naulon_Credits::cursor_for_page( 3 ) ) );
		$this->assertSame( 1, Naulon_Credits::page_from_cursor( '' ) );
		$this->assertSame( 1, Naulon_Credits::page_from_cursor( 'not base64 !!' ) );
		$this->assertSame( 1, Naulon_Credits::page_from_cursor( base64_encode( '-2' ) ) );
	}

	private static function source( $active, $answer, &$asked = null ) {
		return new class( $active, $answer, $asked ) implements Naulon_Byline_Source {
			private $active;
			private $answer;
			private $asked;
			public function __construct( $active, $answer, &$asked ) {
				$this->active = $active;
				$this->answer = $answer;
				$this->asked  = &$asked;
			}
			public function id() {
				return 'fake';
			}
			public function is_active() {
				return $this->active;
			}
			public function for_post( $post ) {
				$this->asked = true;
				return $this->answer;
			}
		};
	}

	public function test_the_first_active_source_with_an_answer_wins_and_inactive_ones_are_never_asked() {
		$asked_inactive = false;
		$asked_later    = false;
		$out            = Naulon_Authors::first_answer(
			array(
				self::source( false, array( array( 'user_id' => 1, 'name' => 'Off' ) ), $asked_inactive ),
				self::source( true, array() ),
				self::source( true, array( array( 'user_id' => 5, 'name' => 'Eve' ) ) ),
				self::source( true, array( array( 'user_id' => 6, 'name' => 'Late' ) ), $asked_later ),
			),
			(object) array( 'ID' => 1 )
		);
		$this->assertSame( array( array( 'user_id' => 5, 'name' => 'Eve' ) ), $out );
		$this->assertFalse( $asked_inactive );
		$this->assertFalse( $asked_later );
	}

	public function test_no_source_answering_leaves_the_post_author_to_the_caller() {
		$this->assertSame( array(), Naulon_Authors::first_answer( array( self::source( true, array() ) ), (object) array( 'ID' => 1 ) ) );
	}
}
