"""Sanitization for values that end up in email headers or HTML email bodies.

Every header value that could carry user-derived text (subject, display
names, Reply-To) goes through ``safe_header`` so CR/LF and other control
characters can never start a new header. Every address goes through
``validate_single_address`` so a field that expects one recipient cannot
smuggle in a second one. HTML bodies use ``escape_html`` for all
user-controlled text; nothing relies on blocklisting tags like ``<script>``.
"""
import html
import re
import unicodedata
from email.utils import formataddr, parseaddr

MAX_SUBJECT_LENGTH = 200
MAX_DISPLAY_NAME_LENGTH = 100
MAX_ADDRESS_LENGTH = 254

_WHITESPACE_RUN = re.compile(r"\s+")
# Deliberately strict: one local part, one domain with a dot, no spaces,
# quotes, angle brackets, commas or semicolons.
_ADDRESS = re.compile(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$")


class InvalidEmailAddress(ValueError):
    """Raised when a value is not exactly one plain email address."""


def _is_control(char: str) -> bool:
    # Cc = C0/C1 controls (includes \r, \n, \t, \x00); Zl/Zp = Unicode line
    # and paragraph separators, which some mail software treats as newlines.
    return unicodedata.category(char) in {"Cc", "Zl", "Zp"}


def safe_header(value: object, max_length: int = MAX_SUBJECT_LENGTH) -> str:
    """Return ``value`` as a single-line header value.

    Control characters (including CR and LF) become spaces, runs of
    whitespace collapse to one space, and the result is trimmed and capped
    at ``max_length`` characters.
    """
    text = "" if value is None else str(value)
    text = "".join(" " if _is_control(ch) else ch for ch in text)
    text = _WHITESPACE_RUN.sub(" ", text).strip()
    if len(text) > max_length:
        text = text[: max_length - 1].rstrip() + "…"
    return text


def validate_single_address(value: object) -> str:
    """Return ``value`` if it is exactly one plain email address, else raise."""
    text = "" if value is None else str(value).strip()
    if not text or len(text) > MAX_ADDRESS_LENGTH:
        raise InvalidEmailAddress("Email address is empty or too long")
    if any(_is_control(ch) for ch in text):
        raise InvalidEmailAddress("Email address contains control characters")
    if not _ADDRESS.fullmatch(text):
        raise InvalidEmailAddress("Value is not exactly one email address")
    # parseaddr must agree that the whole value is the address, with no
    # display name or trailing extra recipients.
    name, parsed = parseaddr(text)
    if name or parsed != text:
        raise InvalidEmailAddress("Value is not exactly one email address")
    return text


def format_mailbox(display_name: object, address: object) -> str:
    """Build a ``Name <address>`` header value with a sanitized, quoted name."""
    clean_address = validate_single_address(address)
    clean_name = safe_header(display_name, MAX_DISPLAY_NAME_LENGTH)
    if not clean_name:
        return clean_address
    return formataddr((clean_name, clean_address))


def escape_html(value: object) -> str:
    """HTML-escape user-controlled text for an email body (quotes included)."""
    return html.escape("" if value is None else str(value), quote=True)


def escape_html_multiline(value: object) -> str:
    """HTML-escape text and keep its line breaks visible."""
    return escape_html(value).replace("\r\n", "\n").replace("\n", "<br>")
