"""The one error every binary parser raises for input it does not understand."""


class FormatError(ValueError):
    """The input is not a layout this tool understands; nothing is guessed past it."""
