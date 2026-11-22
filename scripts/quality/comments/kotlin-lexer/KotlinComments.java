import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.jetbrains.kotlin.lexer.KotlinLexer;
import org.jetbrains.kotlin.lexer.KtTokens;

public final class KotlinComments {
    public static void main(String[] args) throws IOException {
        String input = new String(readAll(System.in), StandardCharsets.UTF_8);
        StringBuilder out = new StringBuilder();
        int cursor = 0;
        while (cursor < input.length()) {
            int newline = input.indexOf('\n', cursor);
            int length = Integer.parseInt(input.substring(cursor, newline));
            String text = input.substring(newline + 1, newline + 1 + length);
            cursor = newline + 1 + length;
            out.append(comments(text)).append('\n');
        }
        System.out.print(out);
    }

    private static String comments(String text) {
        KotlinLexer lexer = new KotlinLexer();
        lexer.start(text);
        StringBuilder ranges = new StringBuilder("[");
        while (lexer.getTokenType() != null) {
            if (KtTokens.COMMENTS.contains(lexer.getTokenType())) {
                if (ranges.length() > 1) ranges.append(',');
                ranges.append('[').append(lexer.getTokenStart()).append(',').append(lexer.getTokenEnd()).append(']');
            }
            lexer.advance();
        }
        return ranges.append(']').toString();
    }

    private static byte[] readAll(InputStream stream) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        stream.transferTo(buffer);
        return buffer.toByteArray();
    }
}
