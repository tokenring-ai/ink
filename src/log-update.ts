import {type Writable} from 'node:stream';
import ansiEscapes from 'ansi-escapes';
import cliCursor from 'cli-cursor';

// ... existing code ...
export type LogUpdate = {
  clear: () => void;
  done: () => void;
  sync: (str: string) => void;
  forceRedraw: () => void;
  (str: string): void;
};

const createStandard = (
// ... existing code ...
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

  // ... existing code ...
  render.sync = (str: string) => {
    const output = str + '\n';
    previousOutput = output;
    previousLineCount = output.split('\n').length;
  };

  render.forceRedraw = () => {
    // Standard mode doesn't need special handling, just clear and let next render redraw
    render.clear();
  };

  return render;
};

const createIncremental = (
// ... existing code ...
  stream: Writable,
  {showCursor = false} = {},
): LogUpdate => {
  let previousLines: string[] = [];
  let previousOutput = '';
  let hasHiddenCursor = false;
  let isInTallMode = false;
  // @ts-ignore
  let committedLineCount = 0; // Lines that are "final" and scrolled up

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
    const terminalHeight = getTerminalHeight();

    // Transition back to normal mode when content fits within terminal height
    if (isInTallMode && nextCount <= terminalHeight) {
      isInTallMode = false;
      committedLineCount = 0;
      // Clear what we can and rewrite from scratch in normal mode
      stream.write(ansiEscapes.eraseLines(Math.min(previousCount, terminalHeight)));
      stream.write(output);
      previousOutput = output;
      previousLines = nextLines;
      return;
    }

    // Transition into tall mode when content exceeds terminal height
    if (!isInTallMode && nextCount > terminalHeight) {
      isInTallMode = true;
      // Erase the previous output completely
      stream.write(ansiEscapes.eraseLines(previousCount));

      // Write all complete lines (except the last one which we'll keep "active")
      for (let i = 0; i < visibleCount; i++) {
        stream.write(nextLines[i]! + '\n');
      }

      previousOutput = output;
      previousLines = nextLines;
      committedLineCount = visibleCount;
      return;
    }

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

        committedLineCount = visibleCount;
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

    // We aggregate all chunks for incremental rendering into a buffer
    const buffer: string[] = [];

    // Clear extra lines if the current content's line count is lower than the previous.
    if (nextCount < previousCount) {
      buffer.push(
        ansiEscapes.eraseLines(previousCount - nextCount + 1),
        ansiEscapes.cursorUp(visibleCount),
      );
    } else {
      buffer.push(ansiEscapes.cursorUp(previousCount - 1));
    }

    for (let i = 0; i < visibleCount; i++) {
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
    committedLineCount = 0;
  };

  render.done = () => {
    previousOutput = '';
    previousLines = [];
    isInTallMode = false;
    committedLineCount = 0;

    if (!showCursor) {
      cliCursor.show();
      hasHiddenCursor = false;
    }
  };
// ... existing code ...
  render.sync = (str: string) => {
    const output = str + '\n';
    previousOutput = output;
    previousLines = output.split('\n');
    const terminalHeight = getTerminalHeight();
    isInTallMode = previousLines.length >= terminalHeight;
    committedLineCount = previousLines.length - 1;
  };

  render.forceRedraw = () => {
    const output = previousOutput;
    // Clear terminal and reset state
    stream.write(ansiEscapes.clearTerminal);
    isInTallMode = false;
    committedLineCount = 0;
    previousOutput = '';
    previousLines = [];
    // Re-render the current output if we have one
    if (output) {
      render(output.slice(0, -1)); // Remove the trailing newline we added
    }
  };

  return render;
};
// ... existing code ...

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
