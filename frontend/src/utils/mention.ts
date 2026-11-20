export type MentionSegment = { type: 'text'; text: string } | { type: 'mention'; nickname: string }

// 닉네임 규칙(2~20자, 문자·숫자·_·-)과 같게 맞춘다. 이메일처럼 앞에 글자가 붙은 @ 는 제외
const MENTION_PATTERN = /(?<![\p{L}\p{N}_-])@([\p{L}\p{N}_-]{2,20})/gu

/** 댓글 본문을 일반 텍스트와 @닉네임 조각으로 나눈다 */
export function splitMentions(content: string): MentionSegment[] {
  const segments: MentionSegment[] = []
  let last = 0
  for (const match of content.matchAll(MENTION_PATTERN)) {
    if (match.index > last) segments.push({ type: 'text', text: content.slice(last, match.index) })
    segments.push({ type: 'mention', nickname: match[1] })
    last = match.index + match[0].length
  }
  if (last < content.length) segments.push({ type: 'text', text: content.slice(last) })
  return segments
}
