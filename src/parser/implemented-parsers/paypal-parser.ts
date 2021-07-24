import {dateFromNamedCommaFormat, dateFromSlashFormat} from '../../augments/date';
import {getEnumTypedValues} from '../../augments/object';
import {collapseSpaces, sanitizeNumberString} from '../../augments/string';
import {ParsedOutput, ParsedTransaction} from '../parsed-output';
import {createStatementParser} from '../statement-parser';

enum State {
    Header = 'header',
    HeaderData = 'header-data',
    Activity = 'activity',
    ExpenseInside = 'expense-inside',
    IncomeInside = 'income-inside',
    ActivityHeader = 'activity-header',
    End = 'end',
}

enum ParsingTriggers {
    Usd = 'USD',
    MustNotify = 'you must notify us no later than',
    Statement = 'statement period',
}

const pageEndRegExp = /^page\s+\d+$/i;
const activityHeader = /date\s+description\s+currency\s+amount\s+fees\s+total/i;
const headerDataLineRegExp =
    /(\w{1,3} \d{1,2},? \d{1,4})\s*-\s*(\w{1,3} \d{1,2},? \d{1,4})\s*(.+)$/;
const transactionStartRegExp = new RegExp(
    `^(\\d{1,2}/\\d{1,2}/\\d{1,4})\\s+(.+?)${ParsingTriggers.Usd}\\s+([-,.\\d]+)\\s+([-,.\\d]+)\\s+([-,.\\d]+)$`,
    'i',
);

export type PaypalTransaction = ParsedTransaction & {
    baseAmount: number;
    fees: number;
};

export type PaypalOutput = ParsedOutput<PaypalTransaction>;

export const paypalStatementParser = createStatementParser<State, PaypalOutput>({
    action: performStateAction,
    next: nextState,
    initialState: State.Header,
    endState: State.End,
    parserKeywords: [...getEnumTypedValues(ParsingTriggers), activityHeader, pageEndRegExp],
});

function performStateAction(currentState: State, line: string, output: PaypalOutput) {
    if (currentState === State.HeaderData && !output.startDate) {
        const match = line.match(headerDataLineRegExp);
        if (match) {
            const [, startDate, endDate, accountId] = match;
            output.startDate = dateFromNamedCommaFormat(startDate);
            output.endDate = dateFromNamedCommaFormat(endDate);
            output.accountSuffix = accountId;
        }
    } else if (currentState === State.Activity) {
        const match = line.match(transactionStartRegExp);
        if (match) {
            const [, date, description, amountString, fees, total] = match;
            const amount = Number(sanitizeNumberString(amountString));
            const newTransaction: PaypalTransaction = {
                date: dateFromSlashFormat(date),
                description: collapseSpaces(description),
                // this assumption that we can always use absolute value here may be wrong
                amount: Math.abs(Number(sanitizeNumberString(total))),
                fees: Math.abs(Number(sanitizeNumberString(fees))),
                baseAmount: Math.abs(amount),
                originalText: [line],
            };
            const array = amount < 0 ? output.expenses : output.incomes;

            array.push(newTransaction);
        }
    } else if (currentState === State.ExpenseInside && line !== '') {
        const lastExpense = output.expenses[output.expenses.length - 1];
        lastExpense.description += '\n' + collapseSpaces(line);
        lastExpense.originalText.push(line);
    } else if (currentState === State.IncomeInside && line !== '') {
        const lastIncome = output.incomes[output.incomes.length - 1];
        lastIncome.description += '\n' + collapseSpaces(line);
        lastIncome.originalText.push(line);
    }

    return output;
}

function nextState(currentState: State, line: string): State {
    line = line.toLowerCase();

    if (line.includes(ParsingTriggers.MustNotify)) {
        return State.End;
    }

    switch (currentState) {
        case State.Header:
            if (line.includes(ParsingTriggers.Statement)) {
                return State.HeaderData;
            } else if (line.match(activityHeader)) {
                return State.ActivityHeader;
            }
            break;
        case State.ActivityHeader:
            if (line === '') {
                return State.Activity;
            }
            break;
        case State.HeaderData:
            return State.Header;
        case State.ExpenseInside:
            if (line === '') {
                return State.Activity;
            }
            break;
        case State.IncomeInside:
            if (line === '') {
                return State.Activity;
            }
            break;
        case State.Activity:
            const match = line.match(transactionStartRegExp);
            if (match) {
                if (Number(sanitizeNumberString(match[5])) < 0) {
                    return State.ExpenseInside;
                } else {
                    return State.IncomeInside;
                }
            } else if (line.match(pageEndRegExp)) {
                return State.Header;
            }
            break;
        case State.End:
            break;
    }

    return currentState;
}
