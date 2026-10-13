# Conservative editor for a single, multi-line Nginx /api/ proxy location.
# Do not treat this as a general Nginx parser: refuse unsupported layouts.
function fail(message) {
    print "无法安全修改 API 配置：" message > "/dev/stderr"
    invalid = 1
    exit 1
}

# Remove comments while respecting quoted strings; count only unquoted braces.
function code_part(line,    result, quote, escaped, i, ch) {
    result = ""
    quote = ""
    escaped = 0
    braces = 0
    for (i = 1; i <= length(line); i++) {
        ch = substr(line, i, 1)
        if (escaped) {
            result = result ch
            escaped = 0
        } else if (ch == "\\") {
            result = result ch
            escaped = 1
        } else if (quote != "") {
            result = result ch
            if (ch == quote) quote = ""
        } else if (ch == "\"" || ch == "'") {
            quote = ch
            result = result ch
        } else if (ch == "#") {
            break
        } else {
            if (ch == "{" || ch == "}") braces++
            result = result ch
        }
    }
    if (quote != "" || escaped) fail("不支持跨行引号或续行，请手工检查。")
    sub(/[ \t\r]+$/, "", result)
    return result
}

{
    lines[NR] = $0
    code = code_part($0)
    if (code ~ /^[ \t]*location[ \t]+(\^~[ \t]+)?\/api\/[ \t]*\{[ \t]*$/) {
        if (inside || ++locations != 1) fail("需要恰好一个 /api/ location。")
        inside = 1
        next
    }
    if (!inside) {
        if (code ~ /^[ \t]*location[ \t]+/ && code ~ /\/api\//) {
            fail("/api/ location 格式不受支持，请使用独立多行块。")
        }
        next
    }
    if (code ~ /^[ \t]*\}[ \t]*$/) {
        inside = 0
        closing = NR
        next
    }
    if (code ~ /^[ \t]*$/) next
    if (braces != 0 || code !~ /^[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]+.*;[ \t]*$/) {
        fail("API 块仅支持单行指令，不能包含嵌套块。")
    }
    if (code ~ /^[ \t]*include[ \t]+/) fail("API 块包含 include，请先展开配置。")
    # Multiple directives on one line cannot be rewritten safely.
    check = code
    sub(/;[ \t]*$/, "", check)
    if (index(check, ";") != 0) fail("API 块不支持一行多条指令。")
    if (code ~ /^[ \t]*proxy_pass[ \t]+/) {
        if (++passes != 1) fail("API 块需要恰好一个 proxy_pass。")
        pass_line = NR
        match($0, /^[ \t]*/)
        pass_indent = substr($0, RSTART, RLENGTH)
        lines[NR] = pass_indent "proxy_pass http://127.0.0.1:10110;"
    }
    if (code ~ /^[ \t]*proxy_set_header[ \t]+["']?[Hh][Oo][Ss][Tt]["']?[ \t]+/) {
        if (++hosts != 1) fail("API 块存在多个 Host 设置。")
        match($0, /^[ \t]*/)
        lines[NR] = substr($0, RSTART, RLENGTH) "proxy_set_header Host $http_host;"
    }
}

END {
    if (invalid) exit 1
    if (inside || locations != 1 || closing == 0 || passes != 1) {
        print "无法安全修改 API 配置：需要唯一且完整的 /api/ 代理块及 proxy_pass。" > "/dev/stderr"
        exit 1
    }
    for (i = 1; i <= NR; i++) {
        print lines[i]
        if (i == pass_line && hosts == 0) {
            print pass_indent "proxy_set_header Host $http_host;"
        }
    }
}
