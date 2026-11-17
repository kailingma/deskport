//! The Guacamole instruction format, as shim/guac.js speaks it: each element
//! is `<length>.<value>`, elements are separated by `,` and an instruction
//! ends with `;`. Lengths count Unicode code points.

pub fn encode(elements: &[&str]) -> String {
    let mut out = String::new();
    for (i, e) in elements.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&e.chars().count().to_string());
        out.push('.');
        out.push_str(e);
    }
    out.push(';');
    out
}

#[derive(Default)]
pub struct Parser {
    buf: String,
}

impl Parser {
    /// Appends text and returns every complete instruction, opcode first.
    /// Err on text that is not Guacamole instructions.
    pub fn push(&mut self, text: &str) -> Result<Vec<Vec<String>>, ()> {
        self.buf.push_str(text);
        let s = self.buf.as_str();
        let mut out = Vec::new();
        let mut pos = 0;
        let mut start = 0;
        let mut elements = Vec::new();
        while pos < s.len() {
            let Some(dot) = s[pos..].find('.').map(|i| pos + i) else { break };
            let len = &s[pos..dot];
            if len.is_empty() || len.len() > 9 || !len.bytes().all(|b| b.is_ascii_digit()) {
                return Err(());
            }
            let n: usize = len.parse().map_err(|_| ())?;
            // The byte index just past n code points, if the text has them and a terminator after.
            let rest = &s[dot + 1..];
            let end = match rest.char_indices().nth(n) {
                Some((i, _)) => dot + 1 + i,
                None => break,
            };
            match s.as_bytes()[end] {
                b',' | b';' => {}
                _ => return Err(()),
            }
            elements.push(s[dot + 1..end].to_string());
            pos = end + 1;
            if s.as_bytes()[end] == b';' {
                out.push(std::mem::take(&mut elements));
                start = pos;
            }
        }
        self.buf.drain(..start);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_lengths_in_code_points() {
        assert_eq!(encode(&["size", "0", "1280", "720"]), "4.size,1.0,4.1280,3.720;");
        assert_eq!(encode(&["", "ab"]), "0.,2.ab;");
        assert_eq!(encode(&["clip", "é😀"]), "4.clip,2.é😀;");
    }

    #[test]
    fn parses_whole_and_split_instructions() {
        let mut p = Parser::default();
        assert_eq!(p.push("3.key,5.65307,1.1;5.mou").unwrap(), vec![vec!["key", "65307", "1"]]);
        assert_eq!(p.push("se,1.1,1.2,1.0;").unwrap(), vec![vec!["mouse", "1", "2", "0"]]);
        assert_eq!(p.push("4.blob,1.0,2.é😀;").unwrap(), vec![vec!["blob", "0", "é😀"]]);
        assert!(p.push("").unwrap().is_empty());
    }

    #[test]
    fn refuses_garbage() {
        assert!(Parser::default().push("ab.c;").is_err());
        assert!(Parser::default().push("3.key:").is_err());
    }
}
