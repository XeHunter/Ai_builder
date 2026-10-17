"""Outbound notification channel adapters.

In-app notifications are database rows (always available). Email/SMS/push go through adapters:
the default ``LogAdapter`` records the message in the application log (clearly *simulated*);
``SmtpEmailAdapter`` sends real email when SMTP_* variables are configured. SMS and mobile push
need a provider account (e.g. an SMS gateway, FCM/APNs) and a native app; they are not implemented.
"""

from __future__ import annotations

import smtplib
from email.message import EmailMessage
from typing import Protocol

from app.core.config import get_settings
from app.core.logging import get_logger

log = get_logger("notifications")


class ChannelAdapter(Protocol):
    channel: str
    simulated: bool

    def send(self, to: str, title: str, body: str) -> str: ...


class LogAdapter:
    simulated = True

    def __init__(self, channel: str) -> None:
        self.channel = channel

    def send(self, to: str, title: str, body: str) -> str:
        log.info("[SIMULATED %s] to=%s title=%r", self.channel.upper(), to, title)
        return "simulated"


class SmtpEmailAdapter:
    channel = "email"
    simulated = False

    def send(self, to: str, title: str, body: str) -> str:
        s = get_settings()
        msg = EmailMessage()
        msg["From"], msg["To"], msg["Subject"] = s.smtp_from, to, title
        msg.set_content(body)
        with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=10) as smtp:
            smtp.starttls()
            if s.smtp_username:
                smtp.login(s.smtp_username, s.smtp_password or "")
            smtp.send_message(msg)
        return "sent"


def get_adapter(channel: str) -> ChannelAdapter:
    s = get_settings()
    if channel == "email" and s.email_provider == "smtp" and s.smtp_host:
        return SmtpEmailAdapter()
    return LogAdapter(channel)
