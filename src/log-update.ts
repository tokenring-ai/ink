import {type Writable} from 'node:stream';
import ansiEscapes from 'ansi-escapes';
import cliCursor from 'cli-cursor';

export type LogUpdate = {
  clear: () => void;
  done: () => void;
  sync: (str: string) => void;
  forceRedraw: () => void;
  setTallMode: (enabled: boolean) => void;
  wantsTallMode: () => boolean;
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

  render.wantsTallMode = () => false;

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
  let wantsTallMode = false;

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

    // In tall mode: use diff algorithm to find divergence point and update from there
    if (isInTallMode) {
      const prevVisibleCount = previousLines.length - 1;

      // Find the first line where content diverges (only compare committed lines, not the active last line)
      let divergenceIndex = 0;
      const minCommittedLength = Math.min(prevVisibleCount - 1, visibleCount - 1);

      while (
        divergenceIndex < minCommittedLength &&
        nextLines[divergenceIndex] === previousLines[divergenceIndex]
        ) {
        divergenceIndex++;
      }

      // Move cursor from "current" position (end of last visible line) back to the
      // first line we need to rewrite.
      const linesFromBottomToDivergence = (prevVisibleCount - 1) - divergenceIndex;
      if (linesFromBottomToDivergence > 0) {
        stream.write(ansiEscapes.cursorUp(linesFromBottomToDivergence));
      }
      stream.write(ansiEscapes.cursorTo(0));

      // Rewrite all lines from divergenceIndex through the last visible line.
      for (let i = divergenceIndex; i < visibleCount - 1; i++) {
        stream.write(ansiEscapes.eraseLine + nextLines[i]! + '\n');
      }

      // Rewrite the last active line without a trailing newline
      if (visibleCount > 0) {
        stream.write(ansiEscapes.eraseLine + nextLines[visibleCount - 1]!);
      }

      // If there used to be more visible lines than we now have, clear them
      if (prevVisibleCount > visibleCount) {
        // Move down line by line, clearing each
        const extraLines = prevVisibleCount - visibleCount;
        for (let i = 0; i < extraLines; i++) {
          stream.write('\n' + ansiEscapes.eraseLine);
        }

        // Move cursor back up to the end of the last active line
        stream.write(ansiEscapes.cursorUp(extraLines));
        stream.write(ansiEscapes.cursorTo(0));
        if (visibleCount > 0) {
          // Reposition cursor at end of last active line
          stream.write(nextLines[visibleCount - 1]!);
        }
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

  render.wantsTallMode = () => wantsTallMode;

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
