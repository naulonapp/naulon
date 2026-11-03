from __future__ import annotations

from conftest import BROWSER_UA, config_doc, gate, json_response
from helpers import facts, naulon, reports

from naulon.core import Continue, Keep, Replace, Respond
from naulon.transport import Response


def headers_of(o: object) -> dict[str, str]:
    if isinstance(o, Keep):
        return dict(o.add_headers)
    assert isinstance(o, Replace)
    return dict(o.response.headers)


def test_a_person_continues_with_zero_network_calls() -> None:
    t = gate()
    n = naulon(t)
    d = n.handle(facts(BROWSER_UA))
    assert d == Continue()
    assert n.finish(facts(BROWSER_UA), d, 200, True) == Keep()
    assert t.calls == [] and reports(n) == []


def test_an_agent_on_an_article_gets_the_gates_402() -> None:
    t = gate()
    n = naulon(t)
    f = facts()
    d = n.handle(f)
    assert isinstance(d, Continue) and d.pending is not None and t.calls == [], "nothing asked before the view"
    out = n.finish(f, d, 200, True)
    assert isinstance(out, Replace) and out.response.status == 402
    h = headers_of(out)
    assert h["PAYMENT-REQUIRED"] == "PAYREQ"
    assert h["Cache-Control"] == "private, no-store" and "User-Agent" in h["Vary"]
    assert reports(n)[0]["verdict"] == "denied" and reports(n)[0]["priceMicro"] == 5000


def test_an_agent_on_a_404_or_redirect_is_kept_and_never_reported() -> None:
    t = gate()
    n = naulon(t)
    for status, tollable in ((404, False), (302, False), (200, False)):
        d = n.handle(facts())
        assert n.finish(facts(), d, status, tollable) == Keep()
    assert t.calls == [] and reports(n) == []


def test_a_paid_retry_keeps_the_body_and_adds_the_gates_headers() -> None:
    n = naulon(gate())
    f = facts(PAYMENT_SIGNATURE="signed")
    out = n.finish(f, n.handle(f), 200, True)
    assert isinstance(out, Keep)
    h = headers_of(out)
    assert h["PAYMENT-RESPONSE"] == "RECEIPT" and h["X-Naulon-License"] == "a.b.c"
    assert h["Cache-Control"] == "private, no-store"
    assert reports(n) == [], "the gate wrote `paid`; reporting it here would count it twice"


def test_a_pending_settlement_answers_503_with_retry_after_and_no_offer() -> None:
    n = naulon(gate({"/_naulon/verify": json_response(409, {"verdict": "pending"})}))
    f = facts(PAYMENT_SIGNATURE="signed")
    out = n.finish(f, n.handle(f), 200, True)
    assert isinstance(out, Replace) and out.response.status == 503
    h = headers_of(out)
    assert h["Retry-After"] == "2" and "PAYMENT-REQUIRED" not in h


def test_a_refused_payment_gets_the_bill_again() -> None:
    for route in (
        json_response(402, {"verdict": "refused"}),
        json_response(413, None),
        Response(403, {}, b"<html>waf"),
    ):
        n = naulon(gate({"/_naulon/verify": route}))
        f = facts(PAYMENT_SIGNATURE="signed")
        out = n.finish(f, n.handle(f), 200, True)
        assert isinstance(out, Replace) and out.response.status == 402


def test_every_gate_failure_serves_the_page() -> None:
    cases = [
        ("quote", {"/_naulon/quote": None}, {}),
        ("verify", {"/_naulon/verify": None}, {"PAYMENT_SIGNATURE": "signed"}),
        ("verify 5xx", {"/_naulon/verify": json_response(502, {})}, {"PAYMENT_SIGNATURE": "signed"}),
        ("licence", {"/_naulon/license/check": None}, {"X_NAULON_LICENSE": "a.b.c"}),
    ]
    for name, over, hdrs in cases:
        n = naulon(gate(over))
        f = facts(**hdrs)
        out = n.finish(f, n.handle(f), 200, True)
        assert isinstance(out, Keep), name
        assert reports(n)[-1]["freeReason"] == "unavailable", name


def test_an_unavailable_rail_serves_and_is_not_reported_twice() -> None:
    n = naulon(gate({"/_naulon/verify": json_response(503, {"verdict": "unavailable"})}))
    f = facts(PAYMENT_SIGNATURE="signed")
    assert isinstance(n.finish(f, n.handle(f), 200, True), Keep)
    assert reports(n) == []


def test_a_paid_licence_rereads_free() -> None:
    n = naulon(gate({"/_naulon/license/check": json_response(200, {"entitled": True, "verdict": "paid"})}))
    f = facts(X_NAULON_LICENSE="a.b.c")
    out = n.finish(f, n.handle(f), 200, True)
    assert isinstance(out, Keep) and reports(n)[0]["verdict"] == "agent-reread"


def test_a_refused_licence_is_for_sale() -> None:
    n = naulon(gate())
    f = facts(X_NAULON_LICENSE="forged")
    out = n.finish(f, n.handle(f), 200, True)
    assert isinstance(out, Replace) and out.response.status == 402


def test_observe_mode_serves_and_reports_once() -> None:
    t = gate({"/_naulon/enforce-config": json_response(200, config_doc(tollMode="observe"))})
    n = naulon(t)
    f = facts(PAYMENT_SIGNATURE="signed")
    out = n.finish(f, n.handle(f), 200, True)
    assert isinstance(out, Keep) and headers_of(out)["Cache-Control"] == "private, no-store"
    assert "/_naulon/verify" not in t.paths(), "observing never settles"
    (r,) = reports(n)
    assert r["verdict"] == "denied" and r["observeOnly"] is True and r["paymentPresented"] is True


def test_a_blocked_crawler_is_refused_before_the_view() -> None:
    n = naulon(gate({"/_naulon/enforce-config": json_response(200, config_doc(block=["gptbot"]))}))
    d = n.handle(facts())
    assert isinstance(d, Respond) and d.status == 403
    assert reports(n)[0]["verdict"] == "blocked"


def test_free_by_terms_is_reported_once_the_view_says_article() -> None:
    n = naulon(gate({"/_naulon/enforce-config": json_response(200, config_doc(agentReadsFree=True))}))
    f = facts()
    d = n.handle(f)
    assert reports(n) == []
    assert n.finish(f, d, 200, True) == Keep()
    assert reports(n)[0]["freeReason"] == "terms"


def test_head_decides_like_get() -> None:
    n = naulon(gate())
    get = n.finish(facts(), n.handle(facts()), 200, True)
    head = n.finish(facts(method="HEAD"), n.handle(facts(method="HEAD")), 200, True)
    assert isinstance(get, Replace) and isinstance(head, Replace)
    assert get.response.status == head.response.status == 402


def test_a_post_is_never_tolled() -> None:
    assert naulon(gate()).handle(facts(method="POST")) == Continue()


def test_a_static_or_discovery_path_is_never_tolled() -> None:
    n = naulon(gate())
    for p in ("/static/app.css", "/feed/", "/sitemap.xml", "/robots.txt", "/_naulon/quote"):
        assert n.handle(facts(path=p)) == Continue(), p


def test_an_inactive_middleware_does_nothing() -> None:
    from naulon.core import Naulon
    from naulon.settings import Settings

    n = Naulon(Settings(gate=None, key=None))
    assert n.handle(facts()) == Continue()


def test_before_the_first_config_everything_passes() -> None:
    from naulon.core import Naulon
    from naulon.settings import Settings

    t = gate()
    n = Naulon(Settings(gate="http://gate", key="k"), transport=t)
    assert n.handle(facts()) == Continue()


def test_the_402_names_its_price_and_a_paid_read_its_charge() -> None:
    from naulon.core import format_crawler_price

    assert [format_crawler_price(m) for m in (5000, 50_000, 1_000_000, 1, 0)] == [
        "USD 0.005",
        "USD 0.05",
        "USD 1.00",
        "USD 0.000001",
        "USD 0.00",
    ]
    n = naulon(gate())
    out = n.finish(facts(), n.handle(facts()), 200, True)
    assert headers_of(out)["crawler-price"] == "USD 0.005"
    n = naulon(gate({"/_naulon/verify": json_response(200, {"verdict": "paid", "chargedMicro": "5000"})}))
    f = facts(PAYMENT_SIGNATURE="s")
    assert headers_of(n.finish(f, n.handle(f), 200, True))["crawler-charged"] == "USD 0.005"
    n = naulon(gate({"/_naulon/verify": json_response(200, {"verdict": "paid", "chargedMicro": "4.2"})}))
    assert "crawler-charged" not in headers_of(n.finish(f, n.handle(f), 200, True))
