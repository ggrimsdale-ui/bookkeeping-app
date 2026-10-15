export type AccountType =
  | 'Bank'
  | 'AccountsReceivable'
  | 'OtherCurrentAsset'
  | 'FixedAsset'
  | 'OtherAsset'
  | 'AccountsPayable'
  | 'CreditCard'
  | 'OtherCurrentLiability'
  | 'LongTermLiability'
  | 'Equity'
  | 'Income'
  | 'CostOfGoodsSold'
  | 'Expense'
  | 'OtherIncome'
  | 'OtherExpense'

export type AccountClass = 'Asset' | 'Liability' | 'Equity' | 'Income' | 'Expense'

interface TypeInfo {
  label: string
  cls: AccountClass
}

export const ACCOUNT_TYPES: Record<AccountType, TypeInfo> = {
  Bank: { label: 'Bank', cls: 'Asset' },
  AccountsReceivable: { label: 'Accounts Receivable', cls: 'Asset' },
  OtherCurrentAsset: { label: 'Other Current Asset', cls: 'Asset' },
  FixedAsset: { label: 'Fixed Asset', cls: 'Asset' },
  OtherAsset: { label: 'Other Asset', cls: 'Asset' },
  AccountsPayable: { label: 'Accounts Payable', cls: 'Liability' },
  CreditCard: { label: 'Credit Card', cls: 'Liability' },
  OtherCurrentLiability: { label: 'Other Current Liability', cls: 'Liability' },
  LongTermLiability: { label: 'Long Term Liability', cls: 'Liability' },
  Equity: { label: 'Equity', cls: 'Equity' },
  Income: { label: 'Income', cls: 'Income' },
  CostOfGoodsSold: { label: 'Cost of Goods Sold', cls: 'Expense' },
  Expense: { label: 'Expense', cls: 'Expense' },
  OtherIncome: { label: 'Other Income', cls: 'Income' },
  OtherExpense: { label: 'Other Expense', cls: 'Expense' }
}

/** Display and report order, matching QuickBooks. */
export const TYPE_ORDER = Object.keys(ACCOUNT_TYPES) as AccountType[]

export function isAccountType(t: string): t is AccountType {
  return t in ACCOUNT_TYPES
}

export function accountClass(t: AccountType): AccountClass {
  return ACCOUNT_TYPES[t].cls
}

/** Assets and expenses carry debit balances; everything else carries credit balances. */
export function isDebitNormal(t: AccountType): boolean {
  const cls = accountClass(t)
  return cls === 'Asset' || cls === 'Expense'
}

/** Income statement accounts reset to zero at each fiscal year end. */
export function isProfitAndLoss(t: AccountType): boolean {
  const cls = accountClass(t)
  return cls === 'Income' || cls === 'Expense'
}
