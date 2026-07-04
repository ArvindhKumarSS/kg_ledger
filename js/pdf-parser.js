/** IOB bank statement PDF parser */

import { parseIndianAmount, toIsoDate } from './utils.js';

const SKIP_PATTERNS = [
  /^INDIAN OVERSEAS BANK/i,
  /^TYPE:/i,
  /^A\/C NO:/i,
  /^M\/S\./i,
  /^CKYC ID:/i,
  /^9 SOUTH AVENUE/i,
  /^CHENNAI,/i,
  /^IFSC CODE:/i,
  /^MICR CODE:/i,
  /^NOMINATION:/i,
  /^STATEMENT OF ACCOUNT/i,
  /^NO\.A6\/10/i,
  /^TEXCO SRINAGAR/i,
  /^PHONE NO/i,
  /^Customer Id/i,
  /^PAGE:/i,
  /^INR\s/,
  /^-{5,}/,
  /^Page Total:/i,
  /^Grand Total:/i,
  /^FFD Balance:/i,
  /^Date Stamp/i,
  /^Manager\s*$/i,
  /^-- \d+ of \d+ --/,
  /^\s*$/,
];

function shouldSkip(line) {
  return SKIP_PATTERNS.some((p) => p.test(line.trim()));
}

function groupTextIntoLines(textItems) {
  const lines = [];
  let currentY = null;
  let currentLine = [];

  const sorted = [...textItems].sort((a, b) => {
    const yDiff = b.transform[5] - a.transform[5];
    if (Math.abs(yDiff) > 2) return yDiff;
    return a.transform[4] - b.transform[4];
  });

  for (const item of sorted) {
    const y = Math.round(item.transform[5]);
    if (currentY === null || Math.abs(y - currentY) <= 3) {
      currentLine.push(item);
      currentY = y;
    } else {
      if (currentLine.length) {
        lines.push(
          currentLine
            .sort((a, b) => a.transform[4] - b.transform[4])
            .map((i) => i.str)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim()
        );
      }
      currentLine = [item];
      currentY = y;
    }
  }
  if (currentLine.length) {
    lines.push(
      currentLine
        .sort((a, b) => a.transform[4] - b.transform[4])
        .map((i) => i.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    );
  }
  return lines.filter(Boolean);
}

function parseLine(line) {
  const balanceMatch = line.match(/([\d,]+\.\d{2})Cr\s*$/i);
  if (!balanceMatch) return null;

  const balance = parseIndianAmount(balanceMatch[1]);
  let beforeBalance = line.slice(0, balanceMatch.index).trim();

  const amountMatch = beforeBalance.match(/([\d,]+\.\d{2})\s*$/);
  if (!amountMatch) {
    const openingMatch = line.match(/^(\d{2}-\d{2}-\d{4})\s+([\d,]+\.\d{2})Cr/i);
    if (openingMatch) {
      return {
        type: 'opening',
        date: toIsoDate(openingMatch[1]),
        balance,
      };
    }
    return null;
  }

  const amount = parseIndianAmount(amountMatch[1]);
  beforeBalance = beforeBalance.slice(0, amountMatch.index).trim();

  const dateMatch = beforeBalance.match(/^(\d{2}-\d{2}-\d{4})\s+(.*)$/);
  if (!dateMatch) return null;

  let details = dateMatch[2].trim();
  let chequeNumber = null;

  const chequeMatch = details.match(/^(.+?)\s+(\d{6})\s*$/);
  if (chequeMatch) {
    const impsLike = /IMPS|UPI|MB\//i.test(details);
    if (!impsLike) {
      details = chequeMatch[1].trim();
      chequeNumber = chequeMatch[2];
    }
  }

  return {
    type: 'transaction',
    date: toIsoDate(dateMatch[1]),
    details,
    chequeNumber,
    amount,
    balance,
  };
}

export async function parsePdfFile(file, pdfjsLib) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const allLines = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    allLines.push(...groupTextIntoLines(content.items));
  }

  const transactions = [];
  const parseWarnings = [];
  let openingBalance = null;
  let prevBalance = null;

  for (const line of allLines) {
    if (shouldSkip(line)) continue;

    const parsed = parseLine(line);
    if (!parsed) {
      if (/\d{2}-\d{2}-\d{4}/.test(line)) {
        parseWarnings.push(`Could not parse line: ${line.slice(0, 80)}`);
      }
      continue;
    }

    if (parsed.type === 'opening') {
      openingBalance = parsed.balance;
      prevBalance = parsed.balance;
      continue;
    }

    if (prevBalance === null) {
      parseWarnings.push(`Transaction before opening balance: ${parsed.details}`);
      prevBalance = parsed.balance;
      continue;
    }

    let creditAmount = null;
    let debitAmount = null;

    if (parsed.balance > prevBalance) {
      creditAmount = parsed.amount;
    } else if (parsed.balance < prevBalance) {
      debitAmount = parsed.amount;
    } else {
      parseWarnings.push(`Zero balance change: ${parsed.details}`);
    }

    transactions.push({
      date: parsed.date,
      details: parsed.details,
      chequeNumber: parsed.chequeNumber,
      creditAmount,
      debitAmount,
      balance: parsed.balance,
    });

    prevBalance = parsed.balance;
  }

  return { transactions, openingBalance, parseWarnings };
}
