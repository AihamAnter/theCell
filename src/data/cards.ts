export type CardClass = 'isBlue' | 'isRed' | 'isNeutral' | 'isAssassin'

export type CardData = {
  img: string
  cls: CardClass
  txt: string
  assassin?: boolean
}

export const cards: CardData[] = [
  { img: 'c01', cls: 'isBlue', txt: 'قلم' },
  { img: 'c02', cls: 'isNeutral', txt: 'جائزة' },
  { img: 'c03', cls: 'isRed', txt: 'جائزة' },
  { img: 'c04', cls: 'isNeutral', txt: 'آثار' },
  { img: 'c05', cls: 'isNeutral', txt: 'آثار' },
  { img: 'c06', cls: 'isBlue', txt: 'ضابط' },
  { img: 'c07', cls: 'isRed', txt: 'برج' },
  { img: 'c08', cls: 'isNeutral', txt: 'برج' },
  { img: 'c09', cls: 'isNeutral', txt: 'بحر' },
  { img: 'c10', cls: 'isNeutral', txt: 'سفينة' },
  { img: 'c11', cls: 'isNeutral', txt: 'كف' },
  { img: 'c12', cls: 'isNeutral', txt: 'كرة' },
  { img: 'c13', cls: 'isNeutral', txt: 'عالم' },
  { img: 'c14', cls: 'isNeutral', txt: 'عنصر' },
  { img: 'c15', cls: 'isBlue', txt: 'تصدّر' },
  { img: 'c16', cls: 'isBlue', txt: 'كرة' },
  { img: 'c17', cls: 'isRed', txt: 'هوائي' },
  { img: 'c18', cls: 'isNeutral', txt: 'بيت' },
  { img: 'c19', cls: 'isBlue', txt: 'بنك' },
  { img: 'c20', cls: 'isNeutral', txt: 'مدرّب' },
  { img: 'c21', cls: 'isNeutral', txt: 'قمر' },
  { img: 'c22', cls: 'isNeutral', txt: 'مفتاح' },
  { img: 'c23', cls: 'isNeutral', txt: 'مطار' },
  { img: 'c24', cls: 'isNeutral', txt: 'سوق' },
  { img: 'c25', cls: 'isAssassin', txt: 'ملف', assassin: true }
]
