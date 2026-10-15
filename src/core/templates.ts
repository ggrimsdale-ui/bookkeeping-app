import type { AccountType } from './accountTypes'

export interface TemplateAccount {
  number: string
  name: string
  type: AccountType
  /** Number of the parent account, for sub-accounts. */
  parent?: string
  system?: 'retainedEarnings' | 'openingBalanceEquity'
}

export type TemplateId = 'general' | 'service' | 'retail' | 'blank'

export const TEMPLATE_LABELS: Record<TemplateId, string> = {
  general: 'General business',
  service: 'Service business',
  retail: 'Retail business',
  blank: 'Blank (system accounts only)'
}

// Every company needs these two equity accounts.
const SYSTEM: TemplateAccount[] = [
  { number: '3000', name: 'Opening Balance Equity', type: 'Equity', system: 'openingBalanceEquity' },
  { number: '3900', name: 'Retained Earnings', type: 'Equity', system: 'retainedEarnings' }
]

const COMMON: TemplateAccount[] = [
  { number: '1000', name: 'Checking', type: 'Bank' },
  { number: '1010', name: 'Savings', type: 'Bank' },
  { number: '1200', name: 'Accounts Receivable', type: 'AccountsReceivable' },
  { number: '1400', name: 'Prepaid Expenses', type: 'OtherCurrentAsset' },
  { number: '1500', name: 'Furniture and Equipment', type: 'FixedAsset' },
  { number: '1590', name: 'Accumulated Depreciation', type: 'FixedAsset' },
  { number: '2000', name: 'Accounts Payable', type: 'AccountsPayable' },
  { number: '2100', name: 'Credit Card', type: 'CreditCard' },
  { number: '2200', name: 'Payroll Liabilities', type: 'OtherCurrentLiability' },
  { number: '2300', name: 'Sales Tax Payable', type: 'OtherCurrentLiability' },
  { number: '2700', name: 'Loan Payable', type: 'LongTermLiability' },
  { number: '3100', name: "Owner's Equity", type: 'Equity' },
  { number: '3110', name: "Owner's Contributions", type: 'Equity', parent: '3100' },
  { number: '3120', name: "Owner's Draws", type: 'Equity', parent: '3100' },
  { number: '6000', name: 'Advertising and Marketing', type: 'Expense' },
  { number: '6050', name: 'Bank Service Charges', type: 'Expense' },
  { number: '6100', name: 'Depreciation Expense', type: 'Expense' },
  { number: '6150', name: 'Insurance Expense', type: 'Expense' },
  { number: '6200', name: 'Interest Expense', type: 'Expense' },
  { number: '6250', name: 'Meals and Entertainment', type: 'Expense' },
  { number: '6300', name: 'Office Supplies', type: 'Expense' },
  { number: '6350', name: 'Payroll Expenses', type: 'Expense' },
  { number: '6360', name: 'Wages', type: 'Expense', parent: '6350' },
  { number: '6370', name: 'Payroll Taxes', type: 'Expense', parent: '6350' },
  { number: '6400', name: 'Professional Fees', type: 'Expense' },
  { number: '6450', name: 'Rent Expense', type: 'Expense' },
  { number: '6500', name: 'Repairs and Maintenance', type: 'Expense' },
  { number: '6550', name: 'Telephone and Internet', type: 'Expense' },
  { number: '6600', name: 'Travel Expense', type: 'Expense' },
  { number: '6650', name: 'Utilities', type: 'Expense' },
  { number: '7000', name: 'Interest Income', type: 'OtherIncome' },
  { number: '8000', name: 'Other Expenses', type: 'OtherExpense' }
]

const TEMPLATES: Record<TemplateId, TemplateAccount[]> = {
  blank: [],
  general: [
    ...COMMON,
    { number: '4000', name: 'Sales', type: 'Income' },
    { number: '4900', name: 'Other Revenue', type: 'Income' },
    { number: '5000', name: 'Cost of Goods Sold', type: 'CostOfGoodsSold' }
  ],
  service: [
    ...COMMON,
    { number: '4000', name: 'Service Revenue', type: 'Income' },
    { number: '4100', name: 'Consulting Revenue', type: 'Income' },
    { number: '4900', name: 'Reimbursed Expenses', type: 'Income' },
    { number: '5000', name: 'Subcontractors', type: 'CostOfGoodsSold' }
  ],
  retail: [
    ...COMMON,
    { number: '1300', name: 'Inventory Asset', type: 'OtherCurrentAsset' },
    { number: '4000', name: 'Merchandise Sales', type: 'Income' },
    { number: '4050', name: 'Sales Discounts', type: 'Income' },
    { number: '4060', name: 'Sales Returns and Allowances', type: 'Income' },
    { number: '5000', name: 'Cost of Goods Sold', type: 'CostOfGoodsSold' },
    { number: '5100', name: 'Freight In', type: 'CostOfGoodsSold' },
    { number: '6700', name: 'Merchant Account Fees', type: 'Expense' }
  ]
}

export function templateAccounts(id: TemplateId): TemplateAccount[] {
  return [...SYSTEM, ...TEMPLATES[id]].sort((a, b) => a.number.localeCompare(b.number))
}
