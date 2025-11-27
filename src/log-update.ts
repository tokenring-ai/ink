import {type Writable} from 'node:stream';
import ansiEscapes from 'ansi-escapes';
import cliCursor from 'cli-cursor';

export type LogUpdate = {
  clear: () => void;
  done: () => void;
  sync: (str: string) => void;
  forceRedraw: () => void;
  setTallMode: (enabled: boolean) => void;
  (str: string): void;
};

const createStandard = (
	stream: Writable,
	{showCursor = false} = {},
): LogUpdate => {
	let previousLineCount = 0;
	let previousOutput = '';
	let hasHiddenCursor = false;

	const render = (str: string) => {
		if (!showCursor && !hasHiddenCursor) {
			cliCursor.hide();
			hasHiddenCursor = true;
		}

		const output = str + '\n';
		if (output === previousOutput) {
			return;
		}

		previousOutput = output;
		stream.write(ansiEscapes.eraseLines(previousLineCount) + output);
		previousLineCount = output.split('\n').length;
	};

	render.clear = () => {
		stream.write(ansiEscapes.eraseLines(previousLineCount));
		previousOutput = '';
		previousLineCount = 0;
	};

	render.done = () => {
		previousOutput = '';
		previousLineCount = 0;

		if (!showCursor) {
			cliCursor.show();
			hasHiddenCursor = false;
		}
	};

  render.sync = (str: string) => {
    const output = str + '\n';
    previousOutput = output;
    previousLineCount = output.split('\n').length;
  };

  render.forceRedraw = () => {
    // Standard mode doesn't need special handling, just clear and let next render redraw
    render.clear();
  };

  render.setTallMode = (_enabled: boolean) => {
    throw new Error("The standard renderer does not support tall mode, use the incremental renderer for tall mode support");
  };

  return render;
};

const createIncremental = (
  stream: Writable,
  {showCursor = false} = {},
): LogUpdate => {
  let previousLines: string[] = [];
  let previousOutput = '';
  let hasHiddenCursor = false;
  let isInTallMode = false;
  let wantsTallMode: boolean | null = null; // null = automatic, true/false = manual override

  const getTerminalHeight = (): number => {
    return (stream as NodeJS.WriteStream).rows || 24;
  };

  const render = (str: string) => {
    if (!showCursor && !hasHiddenCursor) {
      cliCursor.hide();
      hasHiddenCursor = true;
    }

    const output = str + '\n';
    if (output === previousOutput) {
      return;
    }

    const previousCount = previousLines.length;
    const nextLines = output.split('\n');
    const nextCount = nextLines.length;
    const visibleCount = nextCount - 1;

    // Transition back to normal mode
    if (isInTallMode && !wantsTallMode) {
      isInTallMode = false;
      //const terminalHeight = getTerminalHeight();
      // Clear what we can and rewrite from scratch in normal mode
      //stream.write(ansiEscapes.eraseLines(Math.min(previousCount, terminalHeight)));
      stream.write(ansiEscapes.clearTerminal);
      stream.write(output);
      previousOutput = output;
      previousLines = nextLines;
      return;
    }

    // ... existing code ...
    // Transition into tall mode
    if (!isInTallMode && wantsTallMode) {
      isInTallMode = true;
      // Clear terminal and rewrite all content from scratch
      stream.write(ansiEscapes.clearTerminal);

      // Write all lines except the last "active" line with newlines
      for (let i = 0; i < visibleCount - 1; i++) {
        stream.write(nextLines[i]! + '\n');
      }

      // Write the last active line without trailing newline (cursor stays at end for in-place updates)
      if (visibleCount > 0) {
        stream.write(nextLines[visibleCount - 1]!);
      }

      previousOutput = output;
      previousLines = nextLines;
      return;
    }
// ... existing code ...

    // In tall mode: only append new lines, update last line in place
    if (isInTallMode) {
      const prevVisibleCount = previousLines.length - 1;
      const newCommittedLines = visibleCount - prevVisibleCount;

      if (newCommittedLines > 0) {
        // New lines were added.
        // 1. Erase the current active line (which is now complete)
        stream.write(ansiEscapes.eraseLine + ansiEscapes.cursorLeft);

        // 2. Rewrite that line properly with a newline
        stream.write(nextLines[prevVisibleCount - 1]! + '\n');

        // 3. Write any completely new lines in between
        for (let i = prevVisibleCount; i < visibleCount - 1; i++) {
          stream.write(nextLines[i]! + '\n');
        }

        // 4. Write the new active last line (without newline)
        stream.write(nextLines[visibleCount - 1]!);
      } else {
        // Same number of lines - just update the last line in place
        stream.write(ansiEscapes.eraseLine + ansiEscapes.cursorLeft);
        stream.write(nextLines[visibleCount - 1]!);
      }

      previousOutput = output;
      previousLines = nextLines;
      return;
    }

    // Normal mode for short content
    if (output === '\n' || previousOutput.length === 0) {
      stream.write(ansiEscapes.eraseLines(previousCount) + output);
      previousOutput = output;
      previousLines = nextLines;
      return;
    }

		// We aggregate all chunks for incremental rendering into a buffer, and then write them to stdout at the end.
    const buffer: string[] = [];

    // Clear extra lines if the current content's line count is lower than the previous.
    if (nextCount < previousCount) {
      buffer.push(
				// Erases the trailing lines and the final newline slot.
        ansiEscapes.eraseLines(previousCount - nextCount + 1),
				// Positions cursor to the top of the rendered output.
        ansiEscapes.cursorUp(visibleCount),
      );
    } else {
      buffer.push(ansiEscapes.cursorUp(previousCount - 1));
    }

    for (let i = 0; i < visibleCount; i++) {
			// We do not write lines if the contents are the same. This prevents flickering during renders.
      if (nextLines[i] === previousLines[i]) {
        buffer.push(ansiEscapes.cursorNextLine);
        continue;
      }

      buffer.push(ansiEscapes.eraseLine + nextLines[i] + '\n');
    }

    stream.write(buffer.join(''));

    previousOutput = output;
    previousLines = nextLines;
  };

  render.clear = () => {
    const terminalHeight = getTerminalHeight();
    const linesToClear = isInTallMode
      ? terminalHeight
      : previousLines.length;
    stream.write(ansiEscapes.eraseLines(linesToClear));
    previousOutput = '';
    previousLines = [];
    isInTallMode = false;
  };

  render.done = () => {
    previousOutput = '';
    previousLines = [];

    if (!showCursor) {
      cliCursor.show();
      hasHiddenCursor = false;
    }
  };

  render.sync = (str: string) => {
    const output = str + '\n';
    previousOutput = output;
    previousLines = output.split('\n');
  };

  render.forceRedraw = () => {
    const output = previousOutput;
    // Clear terminal and reset state
    stream.write(ansiEscapes.clearTerminal);
    previousOutput = '';
    previousLines = [];
    // Re-render the current output if we have one
    if (output) {
      render(output.slice(0, -1)); // Remove the trailing newline we added
    }
  };

  render.setTallMode = (enabled: boolean) => {
    wantsTallMode = enabled;
  };

  return render;
};

const create = (
	stream: Writable,
	{showCursor = false, incremental = false} = {},
): LogUpdate => {
	if (incremental) {
		return createIncremental(stream, {showCursor});
	}

	return createStandard(stream, {showCursor});
};

const logUpdate = {create};
export default logUpdate;
