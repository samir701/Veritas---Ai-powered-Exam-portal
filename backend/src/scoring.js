import crypto from "node:crypto";

function secureShuffle(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

export function selectAndOrderQuestions(
  specs,
  { drawCount = null, shuffleQuestions = true, shuffleOptions = true } = {}
) {
  let chosen = [...specs];
  if (drawCount !== null && drawCount > 0 && drawCount < chosen.length) {
    chosen = secureShuffle(chosen).slice(0, drawCount);
  } else if (shuffleQuestions && chosen.length > 1) {
    chosen = secureShuffle(chosen);
  }

  return chosen.map((item) => ({
    questionId: item.questionId,
    pointsPossible: item.pointsPossible,
    negativePoints: item.negativePoints,
    optionIds: shuffleOptions && item.optionIds.length > 1 ? secureShuffle(item.optionIds) : [...item.optionIds],
  }));
}

export function gradeAttemptQuestions(rows, correctOptionByQuestion, passingScorePercent) {
  const questionResults = [];
  let rawEarned = 0;
  let totalPossible = 0;

  for (const row of rows) {
    const pts = Number(row.points_possible);
    const neg = Number(row.negative_points || 0);
    totalPossible += pts;
    const selected = row.selected_option_id;
    const correctOpt = correctOptionByQuestion.get(row.question_id);

    let isCorrect = 0;
    let awarded = 0;

    if (!selected) {
      isCorrect = 0;
      awarded = 0;
    } else if (correctOpt && selected === correctOpt) {
      isCorrect = 1;
      awarded = pts;
    } else {
      isCorrect = 0;
      awarded = neg > 0 ? -neg : 0;
    }

    rawEarned += awarded;
    questionResults.push({
      attemptQuestionId: row.id,
      isCorrect,
      pointsAwarded: Math.round(awarded * 100) / 100,
    });
  }

  const scoreEarned = Math.round(Math.max(0, rawEarned) * 100) / 100;
  const scorePossible = Math.round(totalPossible * 100) / 100;
  const scorePercent =
    scorePossible > 0 ? Math.round((scoreEarned / scorePossible) * 1000) / 10 : 0;
  const passed = scorePercent >= Number(passingScorePercent) ? 1 : 0;

  return {
    questionResults,
    scoreEarned,
    scorePossible,
    scorePercent,
    passed,
  };
}

