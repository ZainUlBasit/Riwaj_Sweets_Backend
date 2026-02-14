const jwt = require("jsonwebtoken");
const RefreshModel = require("../Models/RefreshToken");
const access = process.env.ACCESS_SECRET_KEY;
const refresh = process.env.REFRESH_SECRET_KEY;

class JwtService {
  static generateToken(payload) {
    const accessToken = jwt.sign(payload, access);
    const refreshToken = jwt.sign(payload, refresh);

    return { accessToken, refreshToken };
  }

  static async storeRefreshToken(token, userId) {
    try {
      const newRefresh = new RefreshModel({
        token: token,
        user_id: userId,
      });

      const result = await newRefresh.save();
      return { result };
    } catch (error) {
      console.log(error);
    }
  }

  static async verifyAccessToken(token) {
    return jwt.verify(token, access);
  }

  static async verifyRefreshToken(token) {
    return jwt.verify(token, refresh);
  }

  static async findRefreshToken(userId, refreshtoken) {
    const response = await RefreshModel.findOne({
      user_id: userId,
      token: refreshtoken,
    });
    console.log("response: ", response);
    return response;
  }

  static async updateRefreshToken(userId, refreshToken) {
    return await RefreshModel.updateOne(
      { user_id: userId },
      { token: refreshToken }
    );
  }
}

module.exports = JwtService;
