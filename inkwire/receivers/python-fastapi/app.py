"""``uvicorn app:app`` — the wired receiver, configured from the environment.

See :mod:`inkwire_receiver.app` for the factory and the ``INKWIRE_*`` variables.
"""

from inkwire_receiver.app import create_app

app = create_app()
