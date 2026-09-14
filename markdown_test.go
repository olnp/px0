package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMarkdownPreview(t *testing.T) {
	s, root := newTestServer(t)
	src := "# Hello World\n\nSee [deep](sub/deep.py#L2).\n\n## API_reference\n\n```go\nfunc main() {}\n```\n\n- [x] done\n"
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}

	code, m := get(t, s, "/api/markdown?path=README.md")
	if code != 200 {
		t.Fatalf("status %d: %v", code, m)
	}
	out, _ := m["html"].(string)
	for _, want := range []string{
		`<h1 id="hello-world" data-line="1">Hello World</h1>`,
		`<h2 id="api_reference" data-line="5">`,
		`<pre class="md-code" data-line="8" data-lang="go"><code><i class=k>func</i>`,
		`<a href="sub/deep.py#L2">deep</a>`,
		`type="checkbox"`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("preview is missing %q:\n%s", want, out)
		}
	}

	if _, m := get(t, s, "/api/file?path=README.md"); m["markdown"] != true {
		t.Errorf("file response should flag Markdown, got %v", m["markdown"])
	}
	if code, _ := get(t, s, "/api/markdown?path=main.go"); code != 415 {
		t.Errorf("non-Markdown file: status %d, want 415", code)
	}
	if code, _ := get(t, s, "/api/markdown?path=../x.md"); code != 400 {
		t.Errorf("path outside the root: status %d, want 400", code)
	}
}

func TestHeadingIDsFollowGitHub(t *testing.T) {
	ids := &headingIDs{seen: map[string]bool{}}
	for _, c := range []struct{ in, want string }{
		{"Getting Started!", "getting-started"},
		{"snake_case API", "snake_case-api"},
		{"Überblick", "überblick"},
		{"Getting Started", "getting-started-1"},
		{"???", "section"},
	} {
		if got := string(ids.Generate([]byte(c.in), 0)); got != c.want {
			t.Errorf("%q: got %q, want %q", c.in, got, c.want)
		}
	}
}

func TestMathSpans(t *testing.T) {
	for _, c := range []struct {
		in, want string
	}{
		{"$E=mc^2$", `<span class="md-math">E=mc^2</span>`},
		{"$$\\int_0^1 x\\,dx$$", `<span class="md-math md-math-display">\int_0^1 x\,dx</span>`},
		{"pay $5 at the $ booth", "pay $5 at the $ booth"},
		{"\\$5 and $x$", "$5 and"},
		{"`$x$`", "<code>$x$</code>"},
		{"$x is 5 dollars", "$x is 5 dollars"},
		{"$a$ and $b$", `<span class="md-math">a</span> and <span class="md-math">b</span>`},
	} {
		out, err := renderMarkdown([]byte(c.in))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out, c.want) {
			t.Errorf("%q: got %s, want it to contain %q", c.in, out, c.want)
		}
	}
	out, err := renderMarkdown([]byte("```math\n\\frac{a}{b}\n```\n"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `<span class="md-math md-math-display" data-line="2">\frac{a}{b}</span>`) {
		t.Errorf("math fence: got %s", out)
	}
	if strings.Contains(out, "<pre") {
		t.Errorf("math fence rendered as code: %s", out)
	}
	out, err = renderMarkdown([]byte("```mermaid\nflowchart TD\nA-->B\n```\n"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `data-lang="mermaid"`) {
		t.Errorf("mermaid fence lost: %s", out)
	}
}
